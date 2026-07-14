from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import json
import os
import time
import random


BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"

SYSTEM_PROMPT = (
    "Ты — ИИ-тренажер и играешь роль продавца квартиры. Пользователь — риелтор, который звонит тебе по поводу продажи. "
    "Веди себя как реальный собственник: в начале осторожно и немного недоверчиво, но без грубости. "
    "Квартира: 2-комнатная, обычное жилое состояние, продаешь сам, хочешь купить жилье побольше, цену считаешь справедливой, комиссию платить не хочешь. "
    "Не раскрывай всю информацию сразу, отвечай только на вопросы пользователя. Если риелтор вежлив, задает хорошие вопросы, не давит и объясняет пользу — постепенно становись открытее. "
    "Если спорит, давит, пугает или сразу продает услугу — сопротивляйся. Используй возражения: «Я сам продам», «Не хочу платить комиссию», «Вы будете сбивать цену», «У меня уже есть объявление», «Мне нужно подумать», «Что вы конкретно будете делать?». "
    "Отвечай коротко, живо, как в телефонном разговоре. Не подсказывай пользователю и не оценивай его во время диалога. Начни с фразы: «Алло, слушаю»."
)

sessions = {}


def load_dotenv():
    if not ENV_PATH.exists():
        return

    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


load_dotenv()

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8787"))
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "tencent/hy3:free")
PROXY_TOKEN = os.environ.get("PROXY_TOKEN", "SUPER_SECRET_TOKEN")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_HISTORY_MESSAGES = int(os.environ.get("MAX_HISTORY_MESSAGES", "10"))


def get_openrouter_api_key():
    value = os.environ.get("OPENROUTER_API_KEY", "").strip()

    if not value or value == "your_openrouter_api_key_here":
        raise RuntimeError("OPENROUTER_API_KEY не заполнен в .env proxy-сервера")

    return value


def make_session_id():
    return str(int(time.time() * 1000)) + str(random.randint(0, 99999)).zfill(5)


def create_session(collaborator_id="", session_id=""):
    session = {
        "id": str(session_id or make_session_id()),
        "collaborator_id": str(collaborator_id or ""),
        "name": "Новый звонок",
        "messages": [],
    }
    sessions[session["id"]] = session
    return session


def get_or_create_session(session_id, collaborator_id=""):
    session_id = str(session_id or "")

    if session_id in sessions:
        return sessions[session_id]

    return create_session(collaborator_id, session_id)


def make_session_name(prompt):
    title = " ".join(str(prompt or "").split())
    return title[:48] + "..." if len(title) > 48 else title or "Новый звонок"


def ask_openrouter(history):
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + history[-MAX_HISTORY_MESSAGES:],
        "temperature": 0.7,
        "max_tokens": int(os.environ.get("OPENROUTER_MAX_TOKENS", "900")),
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {get_openrouter_api_key()}",
            "HTTP-Referer": "https://education-test.etagi.com",
            "X-Title": "AI Practice",
        },
    )

    try:
        with urlopen(request, timeout=45) as response:
            response_data = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        response_text = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter вернул {error.code}: {response_text}") from error
    except URLError as error:
        raise RuntimeError(f"Не получилось подключиться к OpenRouter: {error}") from error

    return extract_openrouter_answer(response_data)


def extract_openrouter_answer(response_data):
    try:
        choice = response_data["choices"][0]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError(f"OpenRouter вернул ответ без choices: {short_json(response_data)}") from error

    message = choice.get("message", {}) if isinstance(choice, dict) else {}
    content = message.get("content")

    if isinstance(content, str) and content.strip():
        return content.strip()

    if isinstance(content, list):
        parts = []

        for item in content:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())

        if parts:
            return "\n".join(parts)

    text = choice.get("text") if isinstance(choice, dict) else None

    if isinstance(text, str) and text.strip():
        return text.strip()

    output_text = response_data.get("output_text") if isinstance(response_data, dict) else None

    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    finish_reason = choice.get("finish_reason", "") if isinstance(choice, dict) else ""

    reasoning = message.get("reasoning") if isinstance(message, dict) else None

    if isinstance(reasoning, str) and reasoning.strip():
        return "Алло, слушаю."

    raise RuntimeError(
        "OpenRouter вернул пустой content"
        + (f" (finish_reason={finish_reason})" if finish_reason else "")
        + f": {short_json(response_data)}"
    )


def short_json(value):
    return json.dumps(value, ensure_ascii=False)[:1000]


class AiPracticeProxy(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_json({"ok": True, "model": OPENROUTER_MODEL})
            return

        self.send_json({"ok": False, "error": "Not found"}, status=404)

    def do_POST(self):
        try:
            payload = self.read_json_body()

            if payload.get("token") != PROXY_TOKEN:
                self.send_json({"ok": False, "error": "Неверный token"}, status=401)
                return

            if self.path == "/new-session":
                session = create_session(payload.get("collaborator_id", ""))
                self.send_json({
                    "ok": True,
                    "session_id": session["id"],
                    "session_name": session["name"],
                })
                return

            if self.path == "/chat":
                session = get_or_create_session(
                    payload.get("session_id", ""),
                    payload.get("collaborator_id", ""),
                )
                prompt = str(payload.get("prompt", "")).strip()

                if not prompt:
                    self.send_json({"ok": False, "error": "Пустой текст сообщения"}, status=400)
                    return

                session["messages"].append({"role": "user", "content": prompt})
                answer = ask_openrouter(session["messages"])
                session["messages"].append({"role": "assistant", "content": answer})

                if session["name"] == "Новый звонок":
                    session["name"] = make_session_name(prompt)

                self.send_json({
                    "ok": True,
                    "session_id": session["id"],
                    "session_name": session["name"],
                    "answer": answer,
                })
                return

            self.send_json({"ok": False, "error": "Not found"}, status=404)
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=500)

    def read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0"))

        if content_length <= 0:
            return {}

        raw_body = self.rfile.read(content_length)
        return json.loads(raw_body.decode("utf-8"))

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")

        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


if __name__ == "__main__":
    server = HTTPServer((HOST, PORT), AiPracticeProxy)
    print(f"AI Practice proxy: http://{HOST}:{PORT}")
    server.serve_forever()
