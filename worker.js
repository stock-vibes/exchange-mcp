/**
 * Exchange Rate Intelligence API
 * ─────────────────────────────
 * Live currency rates · x402 native · MCP compatible
 * Data source: European Central Bank via Frankfurter.app (free, no key)
 * Price: $0.001 USDC per call on Base network
 */

const CONFIG = {
  PRICE:       "0.001",
  TOKEN:       "USDC",
  NETWORK:     "base",
  WALLET:      "0x4B745B47FcCb254d36fD8e3Bc52484a4405C3f12",   // ← your wallet here
  SOURCE_URL:  "https://api.frankfurter.app",
  NAME:        "Exchange Rate Intelligence API",
  VERSION:     "1.0.0",
  DESCRIPTION: "Live currency exchange rates from the European Central Bank. 33 currencies. x402 native — no signup, no API key, pay per call.",
  TAGS:        ["currency", "exchange-rate", "forex", "finance", "live-data", "x402", "ecb"]
};

// ─── Main Handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const origin = `${url.protocol}//${url.host}`;
    const cors   = getCorsHeaders();

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ── Free endpoints (no payment) ──────────────────────────────────────
      if (path === "/health")                   return handleHealth(cors);
      if (path === "/.well-known/mcp.json")     return handleMcpDiscovery(origin, cors);
      if (path === "/.well-known/agent-card.json") return handleAgentCard(origin, cors);

      // ── MCP JSON-RPC endpoint ─────────────────────────────────────────────
      if (path === "/mcp" && request.method === "POST") {
        return handleMcp(request, cors);
      }

      // ── REST API endpoints (x402 payment required) ────────────────────────
      const paymentError = requirePayment(request, cors);
      if (paymentError) return paymentError;

      if (path === "/rates")      return handleRates(url, cors);
      if (path === "/convert")    return handleConvert(url, cors);
      if (path === "/historical") return handleHistorical(url, cors);
      if (path === "/currencies") return handleCurrencies(cors);

      return jsonResponse({
        error: "Not found",
        endpoints: ["/rates", "/convert", "/historical", "/currencies", "/health", "/mcp"]
      }, cors, 404);

    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error", message: err.message }, cors, 500);
    }
  }
};

// ─── x402 Payment ────────────────────────────────────────────────────────────

function requirePayment(request, cors) {
  const payment = request.headers.get("X-Payment") || request.headers.get("X-Payment-Tx");
  if (payment) return null; // ✓ Payment header present — proceed

  const paymentInfo = {
    error: "Payment required",
    message: `This endpoint costs ${CONFIG.PRICE} ${CONFIG.TOKEN} per call`,
    x402: {
      price:        CONFIG.PRICE,
      currency:     CONFIG.TOKEN,
      network:      CONFIG.NETWORK,
      wallet:       CONFIG.WALLET,
      instructions: [
        "1. Send exactly 0.001 USDC on Base network to the wallet address above",
        "2. Copy your transaction hash",
        "3. Retry this request with header: X-Payment: <your_tx_hash>"
      ]
    }
  };

  return new Response(JSON.stringify(paymentInfo, null, 2), {
    status: 402,
    headers: {
      ...cors,
      "Content-Type":        "application/json",
      "WWW-Authenticate":    `X402 price="${CONFIG.PRICE}" currency="${CONFIG.TOKEN}" network="${CONFIG.NETWORK}" wallet="${CONFIG.WALLET}"`,
      "X-Payment-Price":     CONFIG.PRICE,
      "X-Payment-Currency":  CONFIG.TOKEN,
      "X-Payment-Network":   CONFIG.NETWORK,
      "X-Payment-Wallet":    CONFIG.WALLET
    }
  });
}

// ─── REST Endpoints ───────────────────────────────────────────────────────────

// GET /rates?base=USD&symbols=GBP,EUR,JPY
async function handleRates(url, cors) {
  const base    = (url.searchParams.get("base") || "EUR").toUpperCase();
  const symbols = url.searchParams.get("symbols") || url.searchParams.get("to");

  let apiUrl = `${CONFIG.SOURCE_URL}/latest?from=${base}`;
  if (symbols) apiUrl += `&to=${symbols.toUpperCase()}`;

  const res = await fetch(apiUrl);
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: "Data source error", detail: text }, cors, 502);
  }
  const data = await res.json();

  return jsonResponse({
    base:      data.base,
    date:      data.date,
    rates:     data.rates,
    count:     Object.keys(data.rates).length,
    source:    "European Central Bank",
    timestamp: new Date().toISOString()
  }, cors);
}

// GET /convert?amount=100&from=USD&to=GBP
async function handleConvert(url, cors) {
  const amount = parseFloat(url.searchParams.get("amount") || "1");
  const from   = (url.searchParams.get("from") || "USD").toUpperCase();
  const to     = (url.searchParams.get("to")   || "EUR").toUpperCase();

  if (isNaN(amount) || amount <= 0) {
    return jsonResponse({ error: "Invalid amount — must be a positive number" }, cors, 400);
  }
  if (from === to) {
    return jsonResponse({ amount, from, to, rate: 1, result: amount, date: new Date().toISOString().split("T")[0] }, cors);
  }

  const res = await fetch(`${CONFIG.SOURCE_URL}/latest?from=${from}&to=${to}`);
  if (!res.ok) return jsonResponse({ error: "Data source error" }, cors, 502);
  const data = await res.json();

  const rate = data.rates[to];
  if (!rate) return jsonResponse({ error: `Currency code "${to}" not supported` }, cors, 400);

  return jsonResponse({
    amount,
    from,
    to,
    rate,
    result:    parseFloat((amount * rate).toFixed(6)),
    date:      data.date,
    source:    "European Central Bank",
    timestamp: new Date().toISOString()
  }, cors);
}

// GET /historical?date=2026-01-01&base=USD&symbols=GBP,EUR
async function handleHistorical(url, cors) {
  const date    = url.searchParams.get("date");
  const base    = (url.searchParams.get("base") || "EUR").toUpperCase();
  const symbols = url.searchParams.get("symbols");

  if (!date) return jsonResponse({ error: "date parameter required (YYYY-MM-DD)" }, cors, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: "Invalid date format — use YYYY-MM-DD" }, cors, 400);
  }

  let apiUrl = `${CONFIG.SOURCE_URL}/${date}?from=${base}`;
  if (symbols) apiUrl += `&to=${symbols.toUpperCase()}`;

  const res = await fetch(apiUrl);
  if (!res.ok) return jsonResponse({ error: "Date not available or invalid" }, cors, 400);
  const data = await res.json();

  return jsonResponse({
    base:      data.base,
    date:      data.date,
    rates:     data.rates,
    count:     Object.keys(data.rates).length,
    source:    "European Central Bank",
    timestamp: new Date().toISOString()
  }, cors);
}

// GET /currencies
async function handleCurrencies(cors) {
  const res = await fetch(`${CONFIG.SOURCE_URL}/currencies`);
  if (!res.ok) return jsonResponse({ error: "Data source error" }, cors, 502);
  const data = await res.json();

  return jsonResponse({
    currencies: data,
    count:      Object.keys(data).length,
    source:     "European Central Bank",
    note:       "ECB publishes rates for 33 major currencies daily",
    timestamp:  new Date().toISOString()
  }, cors);
}

// ─── MCP JSON-RPC 2.0 ────────────────────────────────────────────────────────

async function handleMcp(request, cors) {
  let body;
  try { body = await request.json(); }
  catch { return mcpError(null, -32700, "Parse error"); }

  const { method, params, id } = body;

  // ── initialize (free) ────────────────────────────────────────────────────
  if (method === "initialize") {
    return mcpResult(id, {
      protocolVersion: "2024-11-05",
      capabilities:   { tools: {} },
      serverInfo:     { name: CONFIG.NAME, version: CONFIG.VERSION }
    }, cors);
  }

  // ── notifications/initialized (free, no response needed) ─────────────────
  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: cors });
  }

  // ── tools/list (free) ────────────────────────────────────────────────────
  if (method === "tools/list") {
    return mcpResult(id, { tools: getMcpTools() }, cors);
  }

  // ── tools/call (x402 payment required) ───────────────────────────────────
  if (method === "tools/call") {
    const payment = request.headers.get("X-Payment") || request.headers.get("X-Payment-Tx");

    if (!payment) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code:    -32001,
          message: "Payment required",
          data: {
            price:    CONFIG.PRICE,
            currency: CONFIG.TOKEN,
            network:  CONFIG.NETWORK,
            wallet:   CONFIG.WALLET
          }
        }
      }), {
        status: 402,
        headers: {
          ...cors,
          "Content-Type":   "application/json",
          "WWW-Authenticate": `X402 price="${CONFIG.PRICE}" currency="${CONFIG.TOKEN}" network="${CONFIG.NETWORK}" wallet="${CONFIG.WALLET}"`
        }
      });
    }

    const toolName = params?.name;
    const args     = params?.arguments || {};

    try {
      const result = await executeTool(toolName, args);
      return mcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      }, cors);
    } catch (err) {
      return mcpError(id, -32000, err.message, cors);
    }
  }

  return mcpError(id, -32601, `Method not found: ${method}`, cors);
}

async function executeTool(name, args) {
  if (name === "get_rate") {
    const base    = (args.base    || "EUR").toUpperCase();
    const symbols = args.symbols;
    let url       = `${CONFIG.SOURCE_URL}/latest?from=${base}`;
    if (symbols) url += `&to=${symbols.toUpperCase()}`;
    const res  = await fetch(url);
    const data = await res.json();
    return { base: data.base, date: data.date, rates: data.rates, source: "ECB" };
  }

  if (name === "convert") {
    const amount = parseFloat(args.amount || 1);
    const from   = (args.from || "USD").toUpperCase();
    const to     = (args.to   || "EUR").toUpperCase();
    const res    = await fetch(`${CONFIG.SOURCE_URL}/latest?from=${from}&to=${to}`);
    const data   = await res.json();
    const rate   = data.rates[to];
    return { amount, from, to, rate, result: parseFloat((amount * rate).toFixed(6)), date: data.date };
  }

  if (name === "historical") {
    const { date, base = "EUR", symbols } = args;
    let url = `${CONFIG.SOURCE_URL}/${date}?from=${base.toUpperCase()}`;
    if (symbols) url += `&to=${symbols.toUpperCase()}`;
    const res  = await fetch(url);
    const data = await res.json();
    return { base: data.base, date: data.date, rates: data.rates };
  }

  if (name === "currencies") {
    const res  = await fetch(`${CONFIG.SOURCE_URL}/currencies`);
    const data = await res.json();
    return { currencies: data, count: Object.keys(data).length };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function getMcpTools() {
  return [
    {
      name:        "get_rate",
      description: "Get live exchange rates from the European Central Bank. Returns rates for all or specific currencies relative to a base currency.",
      inputSchema: {
        type:       "object",
        properties: {
          base:    { type: "string", description: "Base currency code e.g. USD, GBP, EUR (default: EUR)" },
          symbols: { type: "string", description: "Comma-separated target currencies e.g. GBP,JPY,CHF (omit for all)" }
        }
      }
    },
    {
      name:        "convert",
      description: "Convert an amount from one currency to another using live ECB rates.",
      inputSchema: {
        type:       "object",
        required:   ["from", "to"],
        properties: {
          amount: { type: "number",  description: "Amount to convert (default: 1)" },
          from:   { type: "string",  description: "Source currency e.g. USD" },
          to:     { type: "string",  description: "Target currency e.g. GBP" }
        }
      }
    },
    {
      name:        "historical",
      description: "Get historical exchange rates for any date from 4 January 1999 to present.",
      inputSchema: {
        type:       "object",
        required:   ["date"],
        properties: {
          date:    { type: "string", description: "Date in YYYY-MM-DD format e.g. 2024-06-15" },
          base:    { type: "string", description: "Base currency (default: EUR)" },
          symbols: { type: "string", description: "Target currencies comma-separated (omit for all)" }
        }
      }
    },
    {
      name:        "currencies",
      description: "List all 33 currencies supported by the ECB with their full names.",
      inputSchema: {
        type:       "object",
        properties: {}
      }
    }
  ];
}

// ─── Discovery Endpoints ─────────────────────────────────────────────────────

function handleHealth(cors) {
  return jsonResponse({
    status:    "ok",
    name:      CONFIG.NAME,
    version:   CONFIG.VERSION,
    price:     `${CONFIG.PRICE} ${CONFIG.TOKEN} per call`,
    network:   CONFIG.NETWORK,
    source:    "European Central Bank (Frankfurter.app)",
    timestamp: new Date().toISOString()
  }, cors);
}

function handleMcpDiscovery(origin, cors) {
  return jsonResponse({
    schema:        "mcp-registry/1.0",
    name:          CONFIG.NAME,
    version:       CONFIG.VERSION,
    description:   CONFIG.DESCRIPTION,
    endpoint:      `${origin}/mcp`,
    transport:     "http",
    tools:         ["get_rate", "convert", "historical", "currencies"],
    tags:          CONFIG.TAGS,
    pricing: {
      model:    "x402",
      price:    CONFIG.PRICE,
      currency: CONFIG.TOKEN,
      network:  CONFIG.NETWORK,
      wallet:   CONFIG.WALLET,
      note:     "Pay per call. No subscription. No signup. Agents pay automatically."
    },
    data: {
      source:    "European Central Bank",
      freshness: "Daily (ECB business days)",
      coverage:  "33 major world currencies",
      history:   "4 January 1999 to present"
    },
    links: {
      health:        `${origin}/health`,
      mcp:           `${origin}/mcp`,
      agentCard:     `${origin}/.well-known/agent-card.json`,
      ratesExample:  `${origin}/rates?base=USD`,
      convertExample:`${origin}/convert?amount=100&from=USD&to=GBP`
    }
  }, cors);
}

function handleAgentCard(origin, cors) {
  return jsonResponse({
    name:         CONFIG.NAME,
    version:      CONFIG.VERSION,
    description:  CONFIG.DESCRIPTION,
    url:          origin,
    capabilities: ["currency-conversion", "exchange-rates", "forex", "historical-rates"],
    payment: {
      protocol: "x402",
      network:  CONFIG.NETWORK,
      currency: CONFIG.TOKEN,
      price:    CONFIG.PRICE,
      wallet:   CONFIG.WALLET
    },
    endpoints: {
      mcp:        `${origin}/mcp`,
      rates:      `${origin}/rates`,
      convert:    `${origin}/convert`,
      historical: `${origin}/historical`,
      currencies: `${origin}/currencies`
    }
  }, cors);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Payment, X-Payment-Tx, Authorization"
  };
}

function jsonResponse(data, cors = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

function mcpResult(id, result, cors = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

function mcpError(id, code, message, cors = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
