const http = require("http");
const https = require("https");
const { randomUUID } = require("crypto");
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");

loadEnvFile(join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "tencent/hy3:free";
const PROXY_TOKEN = process.env.PROXY_TOKEN || "SUPER_SECRET_TOKEN";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 10);

const SYSTEM_PROMPT =
    "Ты — ИИ-тренажер и играешь роль продавца квартиры. Пользователь — риелтор, который звонит тебе по поводу продажи. " +
    "Веди себя как реальный собственник: в начале осторожно и немного недоверчиво, но без грубости. " +
    "Квартира: 2-комнатная, обычное жилое состояние, продаешь сам, хочешь купить жилье побольше, цену считаешь справедливой, комиссию платить не хочешь. " +
    "Не раскрывай всю информацию сразу, отвечай только на вопросы пользователя. Если риелтор вежлив, задает хорошие вопросы, не давит и объясняет пользу — постепенно становись открытее. " +
    "Если спорит, давит, пугает или сразу продает услугу — сопротивляйся. Используй возражения: «Я сам продам», «Не хочу платить комиссию», «Вы будете сбивать цену», «У меня уже есть объявление», «Мне нужно подумать», «Что вы конкретно будете делать?». " +
    "Отвечай коротко, живо, как в телефонном разговоре. Не подсказывай пользователю и не оценивай его во время диалога. Начни с фразы: «Алло, слушаю».";

const sessions = new Map();

const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (req.method === "GET" && url.pathname === "/health") {
            sendJson(res, 200, { ok: true, model: OPENROUTER_MODEL });
            return;
        }

        if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "Method not allowed" });
            return;
        }

        const payload = await readJsonBody(req);

        if (payload.token !== PROXY_TOKEN) {
            sendJson(res, 401, { ok: false, error: "Неверный token" });
            return;
        }

        if (url.pathname === "/new-session") {
            const session = createSession(payload.collaborator_id);
            sendJson(res, 200, {
                ok: true,
                session_id: session.id,
                session_name: session.name,
            });
            return;
        }

        if (url.pathname === "/chat") {
            const session = getOrCreateSession(payload.session_id, payload.collaborator_id);
            const prompt = String(payload.prompt || "").trim();

            if (!prompt) {
                sendJson(res, 400, { ok: false, error: "Пустой текст сообщения" });
                return;
            }

            session.messages.push({ role: "user", content: prompt });

            const answer = await askOpenRouter(session.messages);
            session.messages.push({ role: "assistant", content: answer });

            if (session.name === "Новый звонок") {
                session.name = makeSessionName(prompt);
            }

            sendJson(res, 200, {
                ok: true,
                session_id: session.id,
                session_name: session.name,
                answer,
            });
            return;
        }

        sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
        sendJson(res, 500, {
            ok: false,
            error: String(error && error.message ? error.message : error),
        });
    }
});

server.listen(PORT, () => {
    console.log(`AI Practice proxy is listening on http://localhost:${PORT}`);
});

function loadEnvFile(path) {
    if (!existsSync(path)) {
        return;
    }

    const lines = readFileSync(path, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const eqIndex = trimmed.indexOf("=");

        if (eqIndex < 0) {
            continue;
        }

        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";

        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;

            if (body.length > 1024 * 1024) {
                req.destroy();
                reject(new Error("Request body is too large"));
            }
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Некорректный JSON в запросе"));
            }
        });
        req.on("error", reject);
    });
}

function createSession(collaboratorId) {
    const session = {
        id: String(Date.now()) + String(Math.floor(Math.random() * 100000)).padStart(5, "0"),
        collaboratorId: String(collaboratorId || ""),
        name: "Новый звонок",
        messages: [],
        createdAt: new Date().toISOString(),
    };

    sessions.set(session.id, session);
    return session;
}

function getOrCreateSession(sessionId, collaboratorId) {
    const id = String(sessionId || "");

    if (id && sessions.has(id)) {
        return sessions.get(id);
    }

    return createSession(collaboratorId);
}

function makeSessionName(prompt) {
    const normalized = String(prompt).replace(/\s+/g, " ").trim();
    return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized || "Новый звонок";
}

function askOpenRouter(history) {
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === "your_openrouter_api_key_here") {
        throw new Error("OPENROUTER_API_KEY не заполнен в .env proxy-сервера");
    }

    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.slice(-MAX_HISTORY_MESSAGES),
    ];

    const body = JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 260,
    });

    return new Promise((resolve, reject) => {
        const request = https.request(
            {
                hostname: "openrouter.ai",
                path: "/api/v1/chat/completions",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "https://education-test.etagi.com",
                    "X-Title": "AI Practice",
                },
                timeout: 45000,
            },
            (response) => {
                let responseText = "";

                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                    responseText += chunk;
                });
                response.on("end", () => {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`OpenRouter вернул ${response.statusCode}: ${responseText}`));
                        return;
                    }

                    try {
                        const data = JSON.parse(responseText);
                        resolve(String(data.choices[0].message.content || ""));
                    } catch (error) {
                        reject(new Error(`OpenRouter вернул неожиданный ответ: ${responseText.slice(0, 300)}`));
                    }
                });
            }
        );

        request.on("timeout", () => {
            request.destroy(new Error("OpenRouter не ответил за 45 секунд"));
        });
        request.on("error", reject);
        request.write(body);
        request.end();
    });
}
