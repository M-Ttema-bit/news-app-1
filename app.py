"""
NewsAnalyzer Web App — Flask バックエンド (Bulk Processing / 一括分析版)

設計:
- 記事数(最大8件)の本文を1つの巨大なプロンプトに結合
- API呼び出しを「1セッションにつき1回」に削減
- 503エラーや429エラーを根本から排除し、圧倒的な処理速度を実現
- JSON配列として結果を受け取り、安全にパースしてUIへストリーミング
"""

import json
import os
import re
import sys
import threading
import time
import random
from datetime import datetime

# Windows CP932 対策
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CACHE_DIR  = os.path.join(BASE_DIR, "cache")
CACHE_FILE = os.path.join(CACHE_DIR, "auto_results.json")
os.makedirs(CACHE_DIR, exist_ok=True)
os.chdir(BASE_DIR)

import feedparser
import pytz
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
from google import genai

load_dotenv(os.path.join(BASE_DIR, ".env"))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")

# ── 制御パラメータ ───────────────────────────────────────────────
MAX_RETRIES  = 5     # 1回しか呼ばないので503は出にくいが念のため
SCRAPE_DELAY = 0.3   # スクレイピング間の待機（秒）
ARTICLE_MAX  = 8     # Yahoo RSSが配信8件最大なので上限8
ARTICLE_DEF  = 5     # デフォルト記事数

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
CORS(app)
TZ = pytz.timezone("Asia/Tokyo")

# ── RSSフィード定義 ────────────────────────────────────────────────
RSS_FEEDS = {
    "domestic": {
        "label": "国内",
        "url":   "https://news.yahoo.co.jp/rss/topics/domestic.xml",
    },
    "economy": {
        "label": "経済",
        "url":   "https://news.yahoo.co.jp/rss/topics/business.xml",
    },
    "entertainment": {
        "label": "エンタメ",
        "url":   "https://www.4gamer.net/rss/index.xml",
    },
    "world": {
        "label": "世界",
        "url":   "https://news.yahoo.co.jp/rss/topics/world.xml",
    },
    "hardware": {
        "label": "ハードウェア",
        "url":   "https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf",
    },
    "software": {
        "label": "ソフトウェア",
        "url":   "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml",
    },
    "overseas_biz": {
        "label": "海外技術ビジネス",
        "url":   "https://techcrunch.com/feed/",
    },
    "overseas_culture": {
        "label": "海外ITカルチャー",
        "url":   "https://www.theverge.com/rss/index.xml",
    },
    "overseas_tech": {
        "label": "海外技術",
        "url":   "https://feeds.arstechnica.com/arstechnica/index",
    },
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# 全記事を一括分析するプロンプト（要約＋考察 標準モード）
BULK_PROMPT_FULL = """あなたは優秀なニュースアナリストです。以下の{count}件の記事を一括で日本語で分析してください。

{articles_text}

## 出力ルール
- 必ずJSON配列のみを出力すること（コードブロック・説明文は一切不要）
- 配列の要素数は記事数と完全に一致させること（{count}個）
- 各要素のキーは "summary" と "analysis" のみ

## 出力形式
[
  {{
    "summary": "1件目の記事の要約（200〜300字）",
    "analysis": "1件目の記事の社会的・経済的考察と今後の予測（200〜300字）"
  }}
]"""

# 全記事を一括分析するプロンプト（要約のみ 高速モード）
BULK_PROMPT_FAST = """あなたは優秀なニュースアナリストです。以下の{count}件の記事の「要約のみ」を一括で日本語で作成してください。

{articles_text}

## 出力ルール
- 必ずJSON配列のみを出力すること（コードブロック・説明文は一切不要）
- 配列の要素数は記事数と完全に一致させること（{count}個）
- 各要素のキーは "summary" のみ（"analysis"は不要）

## 出力形式
[
  {{
    "summary": "1件目の記事の要約（200〜300字）"
  }}
]"""


# ─── ユーティリティ ──────────────────────────────────────────────────
def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def get_feed_url(feed_key: str) -> str:
    feed = RSS_FEEDS.get(feed_key)
    if feed:
        return feed["url"]
    return RSS_FEEDS["domestic"]["url"]


def scrape_article(url: str, fallback: str = "") -> str:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.encoding = resp.apparent_encoding
        soup = BeautifulSoup(resp.text, "html.parser")
        for sel in ["div.article_body", "div[class*='article_body']",
                    "div[class*='ArticleBody']", "article"]:
            el = soup.select_one(sel)
            if el:
                text = "\n".join(
                    p.get_text(strip=True) for p in el.find_all("p")
                    if p.get_text(strip=True)
                )
                if len(text) > 100:
                    return text[:2000] # 文字数制限（一括送信のため少し短め）
        paragraphs = soup.find_all("p")
        text = "\n".join(
            p.get_text(strip=True) for p in paragraphs
            if len(p.get_text(strip=True)) > 30
        )
        return text[:2000] if text else fallback
    except Exception:
        return fallback


def build_articles_text(articles: list) -> str:
    """記事リストを1プロンプト用テキストに変換"""
    lines = []
    for i, a in enumerate(articles):
        lines.append(f"【記事{i+1}】タイトル: {a['title']}\n本文: {a['content'][:1500]}")
    return "\n\n".join(lines)


def extract_json_array(raw: str) -> list:
    """Geminiレスポンスから JSON配列を多段フォールバックで抽出"""
    if not raw:
        raise ValueError("空のレスポンスです")

    cleaned = re.sub(r"```(?:json|JSON)?\s*", "", raw).replace("```", "").strip()

    try:
        res = json.loads(cleaned)
        if isinstance(res, list): return res
        if isinstance(res, dict): return [res]
    except json.JSONDecodeError:
        pass

    start = cleaned.find('[')
    end   = cleaned.rfind(']')
    if start != -1 and end > start:
        try:
            res = json.loads(cleaned[start:end + 1])
            if isinstance(res, list): return res
        except json.JSONDecodeError:
            pass

    # 最終手段: 正規表現で summary と analysis のペアを抽出
    summaries  = re.findall(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned, re.S)
    analyses   = re.findall(r'"analysis"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned, re.S)
    
    if summaries:
        result = []
        for i, s in enumerate(summaries):
            result.append({
                "summary":  s.replace("\\n", "\n").replace('\\"', '"'),
                "analysis": analyses[i].replace("\\n", "\n").replace('\\"', '"') if i < len(analyses) else "",
            })
        return result

    raise ValueError(f"JSON配列抽出失敗: {cleaned[:150]}")


def call_gemini_once(client, prompt: str) -> str:
    """
    1セッションにつき1回のみ呼ばれる。
    429/503が出た場合は自動的にモデルをフォールバックしてリトライ。
    """
    models_to_try = [GEMINI_MODEL]
    for fallback in ["gemini-2.5-flash", "gemini-2.5-flash-lite"]:
        if fallback not in models_to_try:
            models_to_try.append(fallback)

    last_err = None
    for attempt in range(MAX_RETRIES):
        current_model = models_to_try[min(attempt, len(models_to_try) - 1)]
        try:
            resp = client.models.generate_content(
                model=current_model,
                contents=prompt,
            )
            return resp.text
        except Exception as e:
            last_err  = e
            err_str   = str(e)
            is_429    = "429" in err_str or "RESOURCE_EXHAUSTED" in err_str
            is_503    = "503" in err_str or "UNAVAILABLE" in err_str
            transient = is_429 or is_503

            if transient and attempt < MAX_RETRIES - 1:
                wait = random.uniform(1, 3)
                print(f"[Gemini] {current_model} で {'429' if is_429 else '503'} エラー。{wait:.1f}秒後に次のモデルでリトライします。")
                time.sleep(wait)
                continue

            raise  # 永続エラーまたはリトライ上限
    raise last_err


# ─── キャッシュ管理 ──────────────────────────────────────────────────
def load_cache() -> dict | None:
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


def save_cache(data: dict):
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Cache] 保存エラー: {e}")


# ─── スケジュール実行（一括処理版）──────────────────────────────────────
def run_scheduled_analysis(feed_key: str = "domestic", article_count: int = 5, label: str = "自動"):
    api_key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        print(f"[Scheduler] GEMINI_API_KEY 未設定のためスキップ")
        return

    print(f"[Scheduler] {label} 開始 (feed={feed_key}, model={GEMINI_MODEL})")
    try:
        feed_url = get_feed_url(feed_key)
        feed     = feedparser.parse(feed_url)
        entries  = feed.entries[:article_count]
        if not entries:
            print(f"[Scheduler] 記事0件のためスキップ")
            return

        articles = []
        for entry in entries:
            fallback = entry.get("summary", entry.get("description", ""))
            content  = scrape_article(entry.link, fallback=fallback)
            articles.append({"title": entry.title, "url": entry.link, "content": content})
            time.sleep(SCRAPE_DELAY)

        client = genai.Client(api_key=api_key)
        
        articles_txt = build_articles_text(articles)
        # スケジューラは常に full モード（要約＋考察）で実行
        prompt       = BULK_PROMPT_FULL.format(count=len(articles), articles_text=articles_txt)
        raw          = call_gemini_once(client, prompt)
        data_array   = extract_json_array(raw)

        results = []
        for i, article in enumerate(articles):
            d = data_array[i] if i < len(data_array) else {}
            results.append({
                "title":    article["title"],
                "url":      article["url"],
                "summary":  d.get("summary", "（要約なし）"),
                "analysis": d.get("analysis", "")
            })

        save_cache({
            "last_updated": datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S"),
            "label": label, "feed": feed_key, "model": GEMINI_MODEL,
            "articles": results,
        })
        print(f"[Scheduler] {label} 完了 ({len(results)}件, 1APIコール)")
    except Exception as e:
        print(f"[Scheduler] エラー: {e}")


# ─── APScheduler ────────────────────────────────────────────────────
scheduler = BackgroundScheduler(timezone=TZ)
scheduler.add_job(
    lambda: run_scheduled_analysis("domestic", 5, "朝の自動取得"),
    CronTrigger(hour=7,  minute=0, timezone=TZ), id="morning", replace_existing=True,
)
scheduler.add_job(
    lambda: run_scheduled_analysis("domestic", 5, "夕の自動取得"),
    CronTrigger(hour=18, minute=0, timezone=TZ), id="evening", replace_existing=True,
)
scheduler.start()
print(f"[Scheduler] 朝7:00 / 夕18:00 有効 (model={GEMINI_MODEL})")


# ─── ルーティング ────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/health")
def api_health():
    """
    Render.com スリープ回避およびヘルスチェック用
    """
    return jsonify({"status": "ok", "time": datetime.now(TZ).isoformat()})


@app.route("/api/status")
def api_status():
    key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "")
    return jsonify({
        "api_key_configured": bool(key),
        "model":    GEMINI_MODEL,
        "key_hint": f"...{key[-6:]}" if len(key) > 6 else ("未設定" if not key else "設定済"),
    })


@app.route("/api/feeds")
def api_feeds():
    return jsonify({k: v["label"] for k, v in RSS_FEEDS.items()})


@app.route("/api/cache")
def api_cache():
    cache = load_cache()
    if cache:
        return jsonify(cache)
    return jsonify({"error": "キャッシュがありません"}), 404


@app.route("/api/schedule")
def api_schedule():
    now     = datetime.now(TZ)
    morning = now.replace(hour=7,  minute=0, second=0, microsecond=0)
    evening = now.replace(hour=18, minute=0, second=0, microsecond=0)
    if now < morning:
        next_label = "今日 朝 7:00"
    elif now < evening:
        next_label = "今日 夕 18:00"
    else:
        next_label = "明日 朝 7:00"
    return jsonify({"jobs": ["毎朝 7:00", "毎夕 18:00"], "next_run": next_label})


@app.route("/api/run-now", methods=["POST"])
def api_run_now():
    body = request.get_json(force=True, silent=True) or {}
    feed = body.get("feed", "domestic")
    threading.Thread(
        target=run_scheduled_analysis, args=(feed, 5, "手動実行"), daemon=True
    ).start()
    return jsonify({"status": "started"})


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """
    統合分析エンドポイント（SSEストリーミング）
    Bulk Processing版: 全記事を1つのプロンプトに結合し、1回のAPIコールで完了する
    """
    body          = request.get_json(force=True, silent=True) or {}
    feed_key      = body.get("feed", "domestic")
    article_count = max(1, min(int(body.get("article_count", ARTICLE_DEF)), ARTICLE_MAX))
    api_key       = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "")

    def generate():
        # ── 1. RSS ────────────────────────────────────────────────
        yield sse({"type": "progress", "step": 1, "total": 3,
                   "message": "最新ニュースを取得中..."})
        try:
            feed_url = get_feed_url(feed_key)
            feed     = feedparser.parse(feed_url)
            entries  = feed.entries[:article_count]
            if not entries:
                yield sse({"type": "error", "message": "記事を取得できませんでした。"})
                return
        except Exception as e:
            yield sse({"type": "error", "message": f"RSS取得エラー: {e}"})
            return

        # ── 2. スクレイピング ──────────────────────────────────────
        articles = []
        for i, entry in enumerate(entries):
            yield sse({"type": "progress", "step": 2, "total": 3,
                       "message": f"記事本文を取得中 {i+1}/{len(entries)}..."})
            try:
                fallback = entry.get("summary", entry.get("description", ""))
                content  = scrape_article(entry.link, fallback=fallback)
            except Exception:
                content = ""
            articles.append({"title": entry.title, "url": entry.link, "content": content})
            time.sleep(SCRAPE_DELAY)

        # UIにタイトル一覧を早期送信（カード枠を表示させる）
        yield sse({
            "type":     "articles",
            "articles": [{"title": a["title"], "url": a["url"]} for a in articles],
        })

        # ── 3. APIキー確認 ─────────────────────────────────────────
        if not api_key:
            yield sse({"type": "error", "message": "GEMINI_API_KEY が設定されていません。"})
            return
        try:
            client = genai.Client(api_key=api_key)
        except Exception as e:
            yield sse({"type": "error", "message": f"Gemini 初期化エラー: {e}"})
            return

        # ── 4. Bulk分析 (一括送信) ─────────────────────────────────
        count = len(articles)
        mode = body.get("mode", "full")
        mode_label = "要約のみ/高速" if mode == "summary_only" else "要約＋考察"
        yield sse({"type": "progress", "step": 3, "total": 3,
                   "message": f"AIで全 {count} 件を一括分析中... ({mode_label})"})

        articles_txt = build_articles_text(articles)
        prompt_tmpl  = BULK_PROMPT_FAST if mode == "summary_only" else BULK_PROMPT_FULL
        prompt       = prompt_tmpl.format(count=count, articles_text=articles_txt)

        try:
            raw        = call_gemini_once(client, prompt)
            data_array = extract_json_array(raw)
        except Exception as e:
            err_str = str(e)
            if any(x in err_str for x in ["RESOURCE_EXHAUSTED", "429"]):
                friendly = "APIの一時的な制限が発生しました。再度お試しください。"
            elif any(x in err_str for x in ["UNAVAILABLE", "503"]):
                friendly = "AIサーバーが混雑していました。再度お試しください。"
            else:
                friendly = "一時的なエラーが発生しました。再度お試しください。"
            
            # エラー時は全カードにエラー表示を送信
            for i, article in enumerate(articles):
                yield sse({
                    "type":     "article_result",
                    "index":    i,
                    "title":    article["title"],
                    "url":      article["url"],
                    "summary":  f"⚠️ {friendly}",
                    "analysis": ""
                })
                time.sleep(0.1)
            yield sse({"type": "done"})
            return

        # 結果をカードごとに順次送信 (UIにポンッポンッと表示させる)
        for i, article in enumerate(articles):
            d = data_array[i] if i < len(data_array) else {}
            result = {
                "index":    i,
                "title":    article["title"],
                "url":      article["url"],
                "summary":  d.get("summary", "（要約なし）"),
                "analysis": d.get("analysis", ""),
            }
            yield sse({"type": "article_result", **result})
            time.sleep(0.3)  # アニメーション用の微小待機

        yield sse({"type": "done"})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    # Renderは環境変数 PORT で待ち受けポートを指定する
    port  = int(os.getenv("PORT", os.getenv("FLASK_PORT", 5000)))
    debug = os.getenv("FLASK_DEBUG", "true").lower() == "true"
    print(f"\n[NewsAnalyzer] http://0.0.0.0:{port}")
    print(f"[NewsAnalyzer] Model  : {GEMINI_MODEL}")
    print(f"[NewsAnalyzer] Architecture: 一括処理 (Bulk Processing / 1 API Call)")
    print(f"[NewsAnalyzer] API Key: {'設定済' if GEMINI_API_KEY else '未設定'}\n")
    app.run(host="0.0.0.0", debug=debug, port=port, use_reloader=False)
