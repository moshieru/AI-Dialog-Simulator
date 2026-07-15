function json_escape(value) {
	return String(value)
		.split("\\").join("\\\\")
		.split("\"").join("\\\"")
		.split("\r").join("\\r")
		.split("\n").join("\\n")
		.split("\t").join("\\t");
}

function json_string(value) {
	return "\"" + json_escape(value) + "\"";
}

function parse_json(text) {
	try {
		return JSON.parse(text);
	} catch (e1) {
		return eval("(" + text + ")");
	}
}

function message_json(role, content) {
	return "{\"role\":" + json_string(role) + ",\"content\":" + json_string(content) + "}";
}

function response_text(response) {
	if (response == undefined || response == null) {
		return "";
	}

	try {
		if (response.Body != undefined) {
			return String(response.Body);
		}
	} catch (e1) {}

	try {
		if (response.body != undefined) {
			return String(response.body);
		}
	} catch (e2) {}

	try {
		if (response.Text != undefined) {
			return String(response.Text);
		}
	} catch (e3) {}

	try {
		if (response.text != undefined) {
			return String(response.text);
		}
	} catch (e4) {}

	try {
		if (response.ResponseText != undefined) {
			return String(response.ResponseText);
		}
	} catch (e5) {}

	try {
		if (response.responseText != undefined) {
			return String(response.responseText);
		}
	} catch (e6) {}

	return String(response);
}

function short_text(value) {
	value = String(value);
	return value.length > 1000 ? value.substring(0, 1000) : value;
}

function http_open(request, url, method, body, headers, timeout_sec) {
	var timeout = timeout_sec != undefined ? timeout_sec : 45;

	if (headers == undefined || headers == null) {
		headers = "";
	}

	if (!StrContains(headers, "Accept-Encoding:")) {
		headers += "Accept-Encoding: identity\n";
	}

	return request.Open(url, method, body, headers, null, null, timeout);
}

function extract_answer(response_text_value, fallback_answer) {
	var data = parse_json(response_text_value);
	var choice;
	var message;
	var content;
	var finish_reason;

	try {
		choice = data.choices[0];
	} catch (e1) {
		throw "OpenRouter response has no choices: " + short_text(response_text_value);
	}

	try {
		message = choice.message;
		content = message.content;
	} catch (e2) {
		message = {};
		content = "";
	}

	if (content != undefined && content != null && String(content) != "") {
		return String(content);
	}

	try {
		if (choice.text != undefined && choice.text != null && String(choice.text) != "") {
			return String(choice.text);
		}
	} catch (e3) {}

	try {
		if (data.output_text != undefined && data.output_text != null && String(data.output_text) != "") {
			return String(data.output_text);
		}
	} catch (e4) {}

	try {
		if (message.reasoning != undefined && message.reasoning != null && String(message.reasoning) != "" && fallback_answer != "") {
			return String(fallback_answer);
		}
	} catch (e5) {}

	try {
		finish_reason = choice.finish_reason;
	} catch (e6) {
		finish_reason = "";
	}

	throw "OpenRouter returned empty content" + (finish_reason == "" ? "" : " (finish_reason=" + finish_reason + ")") + ": " + short_text(response_text_value);
}

function ask(oReq, api_key, model, system_prompt, user_prompt, fallback_answer) {
	var body =
		"{\"model\":" + json_string(model) +
		",\"messages\":[" +
			message_json("system", system_prompt) + "," +
			message_json("user", user_prompt) +
		"],\"temperature\":0.7,\"max_tokens\":900}";

	var headers =
		"Content-Type: application/json\n" +
		"Authorization: Bearer " + api_key + "\n" +
		"HTTP-Referer: https://education.etagi.com\n" +
		"X-Title: AI Practice\n";

	var response = http_open(
		oReq,
		"https://openrouter.ai/api/v1/chat/completions",
		"POST",
		body,
		headers,
		45
	);

	return extract_answer(response_text(response), fallback_answer);
}
