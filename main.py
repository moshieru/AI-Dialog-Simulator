from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
import os
import traceback

from openai import OpenAI


HOST = "127.0.0.1"
PORT = 8000
INDEX_HTML_PATH = Path(__file__).with_name("index.html")
CONFIG_PATH = Path(__file__).with_name("config.json")
ENV_PATH = Path(__file__).with_name(".env")


def load_config():
    # Читаем настройки из отдельного JSON-файла, чтобы не править код ради промпта.
    config_text = CONFIG_PATH.read_text(encoding="utf-8")
    config = json.loads(config_text)
    system_prompt = config.get("system_prompt", "").strip()

    if not system_prompt:
        raise ValueError("В config.json должен быть непустой system_prompt")

    return config


def load_dotenv():
    # Локальный .env нужен для секретов на твоем компьютере.
    # Формат строки простой: OPENROUTER_API_KEY=твой_ключ
    if not ENV_PATH.exists():
        return

    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip().strip('"').strip("'")

        # Не перезаписываем переменную, если она уже задана в терминале.
        os.environ.setdefault(name, value)


def get_required_env(name):
    # Секреты лучше хранить в переменных окружения, а не прямо в коде.
    value = os.environ.get(name, "").strip()

    if not value:
        raise ValueError(f"Нужно задать переменную окружения {name}")

    return value


# Системное сообщение задает поведение ассистента.
# Оно не показывается пользователю, но отправляется модели в каждом запросе.
load_dotenv()
CONFIG = load_config()
SYSTEM_MESSAGE = {"role": "system", "content": CONFIG["system_prompt"]}

# Здесь хранится история текущего диалога.
# Важно: модель не помнит прошлые запросы сама, поэтому мы каждый раз
# отправляем ей этот список вместе с новым сообщением пользователя.
dialog_history = [SYSTEM_MESSAGE]

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=get_required_env("OPENROUTER_API_KEY"),
)


def reset_dialog_history():
    # Очищаем историю до системного промпта.
    # После этого модель снова начнет диалог "с нуля", но с прежней ролью.
    dialog_history[:] = [SYSTEM_MESSAGE]


def generate_response(text: str):
    # Добавляем новое сообщение пользователя в историю перед запросом к модели.
    dialog_history.append({"role": "user", "content": text})

    response = client.responses.create(
        model="tencent/hy3:free",
        # Отправляем не только последний промпт, а всю историю диалога.
        # Благодаря этому модель видит предыдущие вопросы и свои ответы.
        input=dialog_history,
    )

    answer = response.output_text

    # Сохраняем ответ модели в историю, чтобы следующий запрос тоже видел его.
    dialog_history.append({"role": "assistant", "content": answer})

    # Оставляем системное сообщение и последние 20 сообщений диалога.
    # Так история не будет бесконечно расти и упираться в лимиты модели.
    if len(dialog_history) > 21:
        dialog_history[:] = [SYSTEM_MESSAGE] + dialog_history[-20:]

    return answer


class DialogHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Браузер сам просит favicon.ico для иконки вкладки.
        # У нас иконки нет, поэтому отвечаем "нет содержимого" без ошибки 404.
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        # Главная страница клиента: браузер запрашивает ее при открытии сайта.
        if self.path == "/":
            self.send_html(INDEX_HTML_PATH)
            return

        # Локальная проверка: сервер жив и отвечает без обращения к нейросети.
        if self.path == "/health":
            self.send_json({"ok": True})
            return

        self.send_json({"error": "Страница не найдена"}, status=404)

    def do_POST(self):
        # API-адрес, куда клиентская часть отправляет промпт пользователя.
        if self.path == "/api/chat":
            self.handle_chat_request()
            return

        # API-адрес для кнопки "Новый чат": чистит память диалога на сервере.
        if self.path == "/api/reset":
            reset_dialog_history()
            self.send_json({"ok": True})
            return

        self.send_json({"error": "Маршрут не найден"}, status=404)

    def handle_chat_request(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))
            prompt = data.get("prompt", "").strip()

            if not prompt:
                self.send_json({"error": "Промпт пустой"}, status=400)
                return

            answer = generate_response(prompt)
            self.send_json({"answer": answer})
        except Exception as error:
            print("Ошибка /api/chat:")
            traceback.print_exc()
            self.send_json({"error": str(error)}, status=500)

    def send_html(self, file_path):
        
        page = file_path.read_text(encoding="utf-8").encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def send_json(self, data, status=200):
        # Универсальный метод для JSON-ответов API.
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = HTTPServer((HOST, PORT), DialogHandler)
    print(f"Сервер запущен: http://{HOST}:{PORT}")
    print("Чтобы остановить сервер, нажмите Ctrl+C.")
    server.serve_forever()
