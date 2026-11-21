export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
        const { message, history = [] } = await request.json();

        const systemPrompt = {
          role: "system",
          content: "Você é um agente autônomo prestativo, objetivo e direto. Responda em português."
        };

        const messages = [
          systemPrompt,
          ...history.slice(-10),
          { role: "user", content: message }
        ];

        const reply = await askGroq(messages, env.LLM_API_KEY);
        return new Response(JSON.stringify({ reply }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/telegram") {
      try {
        const update = await request.json();
        const msg = update.message;

        if (!msg || !msg.text) {
          return new Response("OK", { status: 200 });
        }

        const senderId = String(msg.from.id);
        const allowedId = String(env.ALLOWED_TELEGRAM_ID || "").trim();

        if (!allowedId || senderId !== allowedId) {
          return new Response("Forbidden", { status: 403 });
        }

        const systemPrompt = {
          role: "system",
          content: "Você é um agente autônomo prestativo, objetivo e direto no Telegram. Responda em português."
        };

        const reply = await askGroq(
          [systemPrompt, { role: "user", content: msg.text }],
          env.LLM_API_KEY
        );

        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          msg.chat.id,
          reply
        );

        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }
};

async function askGroq(messages, apiKey) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages,
      temperature: 0.4
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.choices[0].message.content;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const safeText = text.slice(0, 4000);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: safeText
    })
  });
}
