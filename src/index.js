export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Rota do Chat Web (/api/chat)
    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
        const { message, history = [] } = await request.json();
        const reply = await processUserMessage({
          userId: "web-user",
          userText: message,
          fallbackHistory: history,
          env
        });

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

        const reply = await processUserMessage({
          userId: `tg-${senderId}`,
          userText: msg.text,
          fallbackHistory: [],
          env
        });

        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, reply);
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

// Núcleo do Agente: carrega memória, decide ferramentas e salva histórico
async function processUserMessage({ userId, userText, fallbackHistory, env }) {
  // Comando rápido para limpar histórico de conversa se quiser
  if (userText.trim().toLowerCase() === "/limpar") {
    if (env.MEMORY) {
      await env.MEMORY.delete(`chat:${userId}`);
    }
    return "Memória recente da conversa apagada! (Suas notas salvas continuam intactas).";
  }

  // 1. Carrega histórico persistente e notas salvas do Cloudflare KV
  let savedHistory = fallbackHistory;
  let savedNotes = [];

  if (env.MEMORY) {
    const rawHistory = await env.MEMORY.get(`chat:${userId}`);
    if (rawHistory) {
      try {
        savedHistory = JSON.parse(rawHistory);
      } catch (_) {}
    }

    const rawNotes = await env.MEMORY.get(`notes:${userId}`);
    if (rawNotes) {
      try {
        savedNotes = JSON.parse(rawNotes);
      } catch (_) {}
    }
  }

  const notesContext =
    savedNotes.length > 0
      ? `\n\nNOTAS/LEMBRETES SALVOS DO USUÁRIO:\n${savedNotes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`
      : "\n\nNOTAS/LEMBRETES SALVOS DO USUÁRIO: Nenhuma nota salva ainda.";

  const systemPrompt = {
    role: "system",
    content:
      "Você é um agente autônomo pessoal prestativo, objetivo e direto. Responda sempre em português.\n" +
      "Você possui ferramentas externas gratuitas. Quando precisar de dados reais ou salvar algo, responda APENAS com um dos comandos abaixo (sem texto extra):\n" +
      "1. [[WEATHER: Nome da Cidade]] -> para consultar clima e previsão do tempo.\n" +
      "2. [[CURRENCY: VALOR MOEDA_ORIGEM MOEDA_DESTINO]] -> para câmbio (ex: [[CURRENCY: 100 EUR BRL]] ou [[CURRENCY: 1 USD BRL]]).\n" +
      "3. [[WIKI: Termo de busca]] -> para consultar fatos, história, ciência ou conceitos na Wikipedia.\n" +
      "4. [[SAVE_NOTE: texto da nota]] -> quando o usuário pedir para anotar, lembrar ou guardar uma informação/tarefa.\n" +
      "5. [[DELETE_NOTE: número]] -> quando o usuário pedir para apagar uma nota pelo número.\n" +
      "Se não precisar de nenhuma ferramenta, responda diretamente ao usuário usando seu conhecimento e as notas salvas abaixo." +
      notesContext
  };

  const messages = [
    systemPrompt,
    ...savedHistory.slice(-12),
    { role: "user", content: userText }
  ];

  // Primeira chamada ao modelo
  let reply = await askGroq(messages, env.LLM_API_KEY);
  let toolResult = null;

  // Verifica se o agente acionou alguma ferramenta
  const weatherMatch = reply.match(/\[\[WEATHER:\s*(.+?)\]\]/i);
  const currencyMatch = reply.match(/\[\[CURRENCY:\s*([0-9.,]+)\s+([A-Za-z]{3})\s+([A-Za-z]{3})\]\]/i);
  const wikiMatch = reply.match(/\[\[WIKI:\s*(.+?)\]\]/i);
  const saveNoteMatch = reply.match(/\[\[SAVE_NOTE:\s*(.+?)\]\]/i);
  const deleteNoteMatch = reply.match(/\[\[DELETE_NOTE:\s*(\d+)\]\]/i);

  if (weatherMatch) {
    toolResult = await getWeatherFromOpenMeteo(weatherMatch[1].trim());
  } else if (currencyMatch) {
    toolResult = await getCurrencyRate(currencyMatch[1], currencyMatch[2], currencyMatch[3]);
  } else if (wikiMatch) {
    toolResult = await searchWikipedia(wikiMatch[1].trim());
  } else if (saveNoteMatch) {
    const newNote = saveNoteMatch[1].trim();
    savedNotes.push(newNote);
    if (env.MEMORY) {
      await env.MEMORY.put(`notes:${userId}`, JSON.stringify(savedNotes));
    }
    toolResult = `Nota salva com sucesso na memória permanente: "${newNote}". Total de notas agora: ${savedNotes.length}.`;
  } else if (deleteNoteMatch) {
    const idx = parseInt(deleteNoteMatch[1], 10) - 1;
    if (idx >= 0 && idx < savedNotes.length) {
      const removed = savedNotes.splice(idx, 1)[0];
      if (env.MEMORY) {
        await env.MEMORY.put(`notes:${userId}`, JSON.stringify(savedNotes));
      }
      toolResult = `Nota removida: "${removed}".`;
    } else {
      toolResult = `Número de nota inválido. O usuário tem ${savedNotes.length} nota(s).`;
    }
  }

  // Se uma ferramenta foi usada, faz segunda chamada para formular a resposta final
  if (toolResult) {
    const followUpMessages = [
      ...messages,
      { role: "assistant", content: reply },
      {
        role: "user",
        content: `Resultado da ferramenta:\n${toolResult}\n\nAgora responda ao usuário em português de forma natural, clara e objetiva.`
      }
    ];
    reply = await askGroq(followUpMessages, env.LLM_API_KEY);
  }

  // Salva o histórico atualizado no Cloudflare KV (mantém as últimas 16 mensagens)
  if (env.MEMORY) {
    const updatedHistory = [
      ...savedHistory.slice(-14),
      { role: "user", content: userText },
      { role: "assistant", content: reply }
    ];
    await env.MEMORY.put(`chat:${userId}`, JSON.stringify(updatedHistory));
  }

  return reply;
}

// Ferramenta 1: Clima (Open-Meteo - Gratuita, sem chave)
async function getWeatherFromOpenMeteo(city) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`;
  const geoRes = await fetch(geoUrl);
  const geoData = await geoRes.json();

  if (!geoRes.ok || !geoData.results || geoData.results.length === 0) {
    return `Não encontrei a cidade "${city}".`;
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
    return `Erro ao obter previsão para ${place.name}.`;
  }

  const cur = weatherData.current;
  const daily = weatherData.daily;

  const nextDays = (daily?.time || [])
    .map((date, i) => `- ${date}: mín ${daily.temperature_2m_min[i]}°C / máx ${daily.temperature_2m_max[i]}°C (chuva: ${daily.precipitation_probability_max[i]}%)`)
    .join("\n");

  return [
    `Local: ${place.name}, ${place.admin1 || ""} - ${place.country}`,
    `Agora: ${cur.temperature_2m}°C (sensação ${cur.apparent_temperature}°C), umidade ${cur.relative_humidity_2m}%, vento ${cur.wind_speed_10m} km/h`,
    `Próximos dias:\n${nextDays}`
  ].join("\n");
}

// Ferramenta 2: Câmbio (Frankfurter / Banco Central Europeu - Gratuita, sem chave)
async function getCurrencyRate(rawAmount, fromCurrency, toCurrency) {
  const amount = parseFloat(String(rawAmount).replace(",", "."));
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (isNaN(amount) || amount <= 0) {
    return "Valor numérico inválido para conversão.";
  }

  const url = `https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) {
    return `Não foi possível converter de ${from} para ${to}. Verifique se os códigos das moedas estão corretos (ex: EUR, BRL, USD).`;
  }

  const data = await res.json();
  const converted = data.rates?.[to];
  if (!converted) {
    return `Moeda de destino ${to} não encontrada.`;
  }

  return `${amount} ${from} = ${converted} ${to} (cotação oficial de ${data.date}).`;
}

// Ferramenta 3: Enciclopédia (Wikipedia REST API - Gratuita, sem chave)
async function searchWikipedia(query) {
  const searchUrl = `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=1`;
  const searchRes = await fetch(searchUrl, {
    headers: { "User-Agent": "MyAgentCloudflareBot/1.0" }
  });
  const searchData = await searchRes.json();
  const firstHit = searchData?.query?.search?.[0];

  if (!firstHit) {
    return `Nenhum artigo encontrado na Wikipedia em português para "${query}".`;
  }

  const title = firstHit.title;
  const summaryUrl = `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const summaryRes = await fetch(summaryUrl, {
    headers: { "User-Agent": "MyAgentCloudflareBot/1.0" }
  });
  const summaryData = await summaryRes.json();

  return `Artigo: ${summaryData.title}\nResumo: ${summaryData.extract || "Sem resumo disponível."}`;
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
