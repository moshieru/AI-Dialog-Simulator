const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const BASE_DIR = __dirname;
const ENV_PATH = path.join(BASE_DIR, ".env");

const SYSTEM_PROMPT = [
    "Ты — ИИ-тренажер и играешь роль продавца квартиры.",
    "Пользователь — риелтор, который звонит тебе по поводу продажи.",
    "Веди себя как реальный собственник: в начале осторожно и немного недоверчиво, но без грубости.",
    "Квартира: 2-комнатная, обычное жилое состояние, продаешь сам, хочешь купить жилье побольше, цену считаешь справедливой, комиссию платить не хочешь.",
    "Не раскрывай всю информацию сразу, отвечай только на вопросы пользователя.",
    "Если риелтор вежлив, задает хорошие вопросы, не давит и объясняет пользу — постепенно становись открытее.",
    "Если спорит, давит, пугает или сразу продает услугу — сопротивляйся.",
    "Используй возражения: «Я сам продам», «Не хочу платить комиссию», «Вы будете сбивать цену», «У меня уже есть объявление», «Мне нужно подумать», «Что вы конкретно будете делать?».",
    "Отвечай коротко, живо, как в телефонном разговоре.",
    "Не подсказывай пользователю и не оценивай его во время диалога.",
    "Начни с фразы: «Алло, слушаю».",
].join(" ");

const sessions = new Map();

loadDotEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "8787");
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "tencent/hy3:free";
const OPENROUTER_MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || "900");
const PROXY_TOKEN = process.env.PROXY_TOKEN || "SUPER_SECRET_TOKEN";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || "10");

function loadDotEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        return;
    }

    const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#") || !trimmedLine.includes("=")) {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf("=");
        const name = trimmedLine.slice(0, separatorIndex).trim();
        const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");

        if (name && process.env[name] === undefined) {
            process.env[name] = value;
        }
    }
}

function getOpenRouterApiKey() {
    const value = String(process.env.OPENROUTER_API_KEY || "").trim();

    if (!value || value === "your_openrouter_api_key_here") {
        throw new Error("OPENROUTER_API_KEY не заполнен в .env proxy-сервера");
    }

    return value;
}

function makeSessionId() {
    return String(Date.now()) + String(Math.floor(Math.random() * 100000)).padStart(5, "0");
}

function createSession(collaboratorId = "", sessionId = "") {
    const session = {
        id: String(sessionId || makeSessionId()),
        collaboratorId: String(collaboratorId || ""),
        name: "Новый звонок",
        messages: [],
    };

    sessions.set(session.id, session);
    return session;
}

function getOrCreateSession(sessionId, collaboratorId = "") {
    const normalizedSessionId = String(sessionId || "");

    if (sessions.has(normalizedSessionId)) {
        return sessions.get(normalizedSessionId);
    }

    return createSession(collaboratorId, normalizedSessionId);
}

function makeSessionName(prompt) {
    const title = String(prompt || "").replace(/\s+/g, " ").trim();
    return title ? (title.length > 48 ? `${title.slice(0, 48)}...` : title) : "Новый звонок";
}

async function askOpenRouter(history) {
    const payload = {
        model: OPENROUTER_MODEL,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...history.slice(-MAX_HISTORY_MESSAGES),
        ],
        temperature: 0.7,
        max_tokens: OPENROUTER_MAX_TOKENS,
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${getOpenRouterApiKey()}`,
            "HTTP-Referer": "https://education-test.etagi.com",
            "X-Title": "AI Practice",
        },
        body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData;

    try {
        responseData = JSON.parse(responseText);
    } catch (error) {
        throw new Error(`OpenRouter вернул не JSON: ${responseText.slice(0, 1000)}`);
    }

    if (!response.ok) {
        throw new Error(`OpenRouter вернул ${response.status}: ${shortJson(responseData)}`);
    }

    return extractOpenRouterAnswer(responseData);
}

function extractOpenRouterAnswer(responseData) {
    const choice = responseData?.choices?.[0];

    if (!choice) {
        throw new Error(`OpenRouter вернул ответ без choices: ${shortJson(responseData)}`);
    }

    const message = choice.message || {};
    const content = message.content;

    if (typeof content === "string" && content.trim()) {
        return content.trim();
    }

    if (Array.isArray(content)) {
        const parts = content
            .map((item) => {
                if (typeof item === "string") {
                    return item.trim();
                }

                if (item && typeof item === "object") {
                    return String(item.text || item.content || "").trim();
                }

                return "";
            })
            .filter(Boolean);

        if (parts.length) {
            return parts.join("\n");
        }
    }

    if (typeof choice.text === "string" && choice.text.trim()) {
        return choice.text.trim();
    }

    if (typeof responseData.output_text === "string" && responseData.output_text.trim()) {
        return responseData.output_text.trim();
    }

    if (typeof message.reasoning === "string" && message.reasoning.trim()) {
        return "Алло, слушаю.";
    }

    const finishReason = choice.finish_reason ? ` (finish_reason=${choice.finish_reason})` : "";
    throw new Error(`OpenRouter вернул пустой content${finishReason}: ${shortJson(responseData)}`);
}

function shortJson(value) {
    return JSON.stringify(value).slice(0, 1000);
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";

        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;

            if (body.length > 1024 * 1024) {
                reject(new Error("Слишком большой запрос"));
                request.destroy();
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

async function readJsonBody(request) {
    const body = await readRequestBody(request);

    if (!body) {
        return {};
    }

    return JSON.parse(body);
}

function sendJson(response, data, status = 200) {
    const body = JSON.stringify(data);

    response.writeHead(status, {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
}

async function handlePost(request, response, pathname) {
    const payload = await readJsonBody(request);

    if (payload.token !== PROXY_TOKEN) {
        sendJson(response, { ok: false, error: "Неверный token" }, 401);
        return;
    }

    if (pathname === "/new-session") {
        const session = createSession(payload.collaborator_id || "");
        sendJson(response, {
            ok: true,
            session_id: session.id,
            session_name: session.name,
        });
        return;
    }

    if (pathname === "/chat") {
        const session = getOrCreateSession(payload.session_id || "", payload.collaborator_id || "");
        const prompt = String(payload.prompt || "").trim();

        if (!prompt) {
            sendJson(response, { ok: false, error: "Пустой текст сообщения" }, 400);
            return;
        }

        session.messages.push({ role: "user", content: prompt });
        const answer = await askOpenRouter(session.messages);
        session.messages.push({ role: "assistant", content: answer });

        if (session.name === "Новый звонок") {
            session.name = makeSessionName(prompt);
        }

        sendJson(response, {
            ok: true,
            session_id: session.id,
            session_name: session.name,
            answer,
        });
        return;
    }

    sendJson(response, { ok: false, error: "Not found" }, 404);
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    try {
        if (request.method === "OPTIONS") {
            response.writeHead(204, {
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            });
            response.end();
            return;
        }

        if (request.method === "GET" && url.pathname === "/health") {
            sendJson(response, { ok: true, model: OPENROUTER_MODEL });
            return;
        }

        if (request.method === "POST") {
            await handlePost(request, response, url.pathname);
            return;
        }

        sendJson(response, { ok: false, error: "Not found" }, 404);
    } catch (error) {
        sendJson(response, { ok: false, error: String(error.message || error) }, 500);
    }
});

server.listen(PORT, HOST, () => {
    console.log(`AI Practice proxy: http://${HOST}:${PORT}`);
});
