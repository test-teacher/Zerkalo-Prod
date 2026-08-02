import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.warn("ВНИМАНИЕ: переменная окружения BOT_TOKEN не задана. Оплата не будет работать.");
}
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!process.env.DATABASE_URL) {
  console.warn("ВНИМАНИЕ: переменная окружения DATABASE_URL не задана. База данных не будет работать.");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===== таблица создаётся автоматически при первом запуске =====
   Ничего вручную в Supabase создавать не нужно. */
async function ensureTable() {
  await pool.query(`
    create table if not exists users (
      user_id text primary key,
      is_pro boolean not null default false,
      products jsonb not null default '{}'::jsonb,
      paid_at timestamptz,
      updated_at timestamptz not null default now()
    );
  `);
  console.log("Таблица users готова.");
}
ensureTable().catch((e) => console.error("Не удалось создать таблицу:", e.message));

async function getUser(userId) {
  const r = await pool.query("select * from users where user_id = $1", [String(userId)]);
  return r.rows[0] || null;
}

async function markPaid(userId, productId) {
  await pool.query(
    `insert into users (user_id, is_pro, products, paid_at, updated_at)
     values ($1, true, jsonb_build_object($2::text, true), now(), now())
     on conflict (user_id) do update set
       is_pro = true,
       products = users.products || jsonb_build_object($2::text, true),
       paid_at = now(),
       updated_at = now()`,
    [String(userId), productId]
  );
}

/* ===== товары, которые продаём за Telegram Stars =====
   price — цена в звёздах (целое число, дробей нет) */
const PRODUCTS = {
  pro_archive: {
    title: "Zerkalo Pro",
    description: "Полный архив тестов без ограничений + доступ к закрытым тестам",
    price: 50
  }
};

app.get("/", (req, res) => {
  res.send("Zerkalo backend работает.");
});

/**
 * Мини-апп вызывает этот endpoint, чтобы получить ссылку на оплату.
 * body: { userId: string|number, productId: string }
 */
app.post("/create-invoice", async (req, res) => {
  const { userId, productId } = req.body || {};
  const product = PRODUCTS[productId];

  if (!userId || !product) {
    return res.status(400).json({ error: "userId или productId некорректны" });
  }

  try {
    const r = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: product.title,
        description: product.description,
        payload: JSON.stringify({ userId, productId }),
        provider_token: "", // для Telegram Stars всегда пустая строка
        currency: "XTR",    // код валюты Telegram Stars
        prices: [{ label: product.title, amount: product.price }]
      })
    });
    const data = await r.json();
    if (!data.ok) {
      return res.status(500).json({ error: data.description || "Telegram API error" });
    }
    res.json({ link: data.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Telegram отправляет сюда все обновления бота (webhook).
 * Нужно обработать 2 типа события: pre_checkout_query и successful_payment.
 */
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    if (update.pre_checkout_query) {
      // Обязательно подтвердить платёж в течение 10 секунд
      await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true
        })
      });
    }

    if (update.message && update.message.successful_payment) {
      const payload = JSON.parse(update.message.successful_payment.invoice_payload);
      await markPaid(payload.userId, payload.productId);
      console.log(`Пользователь ${payload.userId} оплатил ${payload.productId}`);
    }
  } catch (e) {
    console.error("Ошибка обработки webhook:", e.message);
  }

  res.sendStatus(200);
});

/**
 * Мини-апп проверяет, есть ли у пользователя Pro-доступ.
 * query: ?userId=123
 */
app.get("/pro-status", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId обязателен" });
  try {
    const user = await getUser(userId);
    res.json({ pro: !!(user && user.is_pro) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Zerkalo backend запущен на порту " + PORT));
