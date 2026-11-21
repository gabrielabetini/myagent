export async function onRequestPost(context) {
  const { request, env } = context;

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

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.LLM_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.4
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ error: data }), { status: 500 });
    }

    const reply = data.choices[0].message.content;

    return new Response(JSON.stringify({ reply }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
