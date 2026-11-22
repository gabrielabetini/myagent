export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Rota do Chat Web (/api/chat)
    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
        const { message, history = [] } = await request.json();

        const systemPrompt = {
          role: "system",
          content:
            "Você é um agente autônomo prestativo, objetivo e direto. Responda em português. " +
            "Quando o usuário perguntar sobre clima ou previsão do tempo de algum lugar, NÃO invente dados: " +
            "responda APENAS com [[WEATHER: Nome da Cidade]] para o sistema consultar a previsão real."
        };

        const messages = [
          systemPrompt,
          ...history.slice(-10),
          { role: "user", content: message }
        ];

        const reply = await runAgentWithWeather(messages, env.LLM_API_KEY);
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

    // 2. Rota do Telegram (/api/telegram)
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
          content:
            "Você é um agente autônomo prestativo, objetivo e direto no Telegram. Responda em português. " +
            "Quando o usuário perguntar sobre clima ou previsão do tempo de algum lugar, NÃO invente dados: " +
            "responda APENAS com [[WEATHER: Nome da Cidade]] para o sistema consultar a previsão real."
        };

        const reply = await runAgentWithWeather(
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

// Decide se precisa buscar clima antes de responder
async function runAgentWithWeather(messages, apiKey) {
  const firstReply = await askGroq(messages, apiKey);

  // Verifica se a IA pediu os dados do tempo
  const match = firstReply.match(/\[\[WEATHER:\s*(.+?)\]\]/i);
  if (!match) {
    return firstReply;
  }

  const city = match[1].trim();
  const weatherData = await getWeatherFromOpenMeteo(city);

  const followUpMessages = [
    ...messages,
    { role: "assistant", content: firstReply },
    {
      role: "user",
      content: `Dados reais do tempo para "${city}":\n${weatherData}\n\nAgora responda ao usuário em português de forma clara e objetiva usando esses dados.`
    }
  ];

  return await askGroq(followUpMessages, apiKey);
}

// Busca cidade + previsão do tempo gratuitamente na Open-Meteo
async function getWeatherFromOpenMeteo(city) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`;
  const geoRes = await fetch(geoUrl);
  const geoData = await geoRes.json();

  if (!geoRes.ok || !geoData.results || geoData.results.length === 0) {
    return `Não encontrei a cidade "${city}". Peça ao usuário para confirmar o nome da cidade.`;
  }

  const place = geoData.results[0];
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=3`;

  const weatherRes = await fetch(forecastUrl);
  const weatherData = await weatherRes.json();

  if (!weatherRes.ok || !weatherData.current) {
    return `Não foi possível obter a previsão do tempo para ${place.name} agora.`;
  }

  const cur = weatherData.current;
  const daily = weatherData.daily;

  const nextDays = (daily?.time || [])
    .map((date, i) => {
      return `- ${date}: mín ${daily.temperature_2m_min[i]}°C / máx ${daily.temperature_2m_max[i]}°C (chance de chuva: ${daily.precipitation_probability_max[i]}%)`;
    })
    .join("\n");

  return [
    `Cidade: ${place.name}, ${place.admin1 || ""} - ${place.country}`,
    `Agora: ${cur.temperature_2m}°C (sensação de ${cur.apparent_temperature}°C), umidade ${cur.relative_humidity_2m}%, vento ${cur.wind_speed_10m} km/h, chuva agora ${cur.precipitation} mm`,
    `Previsão para os próximos dias:\n${nextDays}`
  ].join("\n");
}

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
