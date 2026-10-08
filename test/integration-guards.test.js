const assert = require("node:assert/strict");
const test = require("node:test");

const { createIdPageTracker } = require("../src/lib/page-progress");
const {
  retryableSupabaseError,
  upsertRows,
} = require("../src/lib/supabase-upsert");
const { extractZenviaList } = require("../src/zenvia/response");
const { extractZohoRecords } = require("../src/zoho/response");

test("respostas 200 exigem listas explicitas", () => {
  assert.deepEqual(
    extractZohoRecords({ status: 200, data: { data: [] } }, "teste"),
    [],
  );
  assert.deepEqual(
    extractZohoRecords({ status: 200, data: { code: 3100 } }, "teste"),
    [],
  );
  assert.deepEqual(
    extractZohoRecords(
      {
        status: 200,
        data: { code: 3100, data: null, message: "No Data Available" },
      },
      "teste",
    ),
    [],
  );
  assert.throws(
    () => extractZohoRecords({ status: 200, data: {} }, "teste"),
    (error) =>
      error.code === "ZOHO_INVALID_RECORD_LIST" &&
      /lista invalida/.test(error.message),
  );
  assert.deepEqual(
    extractZenviaList(
      { status: 200, data: { dados: { relatorio: [] } } },
      "relatorio",
      "teste",
    ),
    [],
  );
  assert.throws(
    () =>
      extractZenviaList(
        { status: 200, data: { dados: {} } },
        "relatorio",
        "teste",
      ),
    /lista invalida/,
  );
});

test("rastreador interrompe pagina repetida ou sem progresso", () => {
  const tracker = createIdPageTracker({
    source: "teste",
    idOf: (record) => record.ID,
  });
  tracker.observe([{ ID: "1" }, { ID: "2" }]);
  assert.throws(
    () => tracker.observe([{ ID: "1" }, { ID: "2" }]),
    /repetiu uma pagina/,
  );

  const reordered = createIdPageTracker({
    source: "teste",
    idOf: (record) => record.ID,
  });
  reordered.observe([{ ID: "1" }, { ID: "2" }]);
  assert.throws(
    () => reordered.observe([{ ID: "2" }, { ID: "1" }]),
    /nao avancou/,
  );
});

test("upsert classifica rede, 408, 429 e qualquer 5xx como transitorio", () => {
  assert.equal(retryableSupabaseError({ code: "ECONNRESET" }), true);
  assert.equal(
    retryableSupabaseError({ name: "TypeError", message: "fetch failed" }),
    true,
  );
  assert.equal(retryableSupabaseError({ response: { status: 408 } }), true);
  assert.equal(retryableSupabaseError({ response: { status: 429 } }), true);
  assert.equal(retryableSupabaseError({ response: { status: 599 } }), true);
  assert.equal(retryableSupabaseError({ response: { status: 400 } }), false);
});

test("upsert idempotente repete 503 e nao expoe mensagem remota", async () => {
  let attempts = 0;
  const supabase = {
    from: () => ({
      upsert: async () => {
        attempts++;
        if (attempts === 1) {
          return {
            status: 503,
            error: { code: "PGRST503", message: "payload remoto sigiloso" },
          };
        }
        return { status: 201, error: null };
      },
    }),
  };

  await upsertRows({
    client: supabase,
    table: "raw_test",
    rows: [{ external_id: "1", payload: {} }],
    maxAttempts: 2,
    baseMs: 1,
    maxMs: 1,
  });
  assert.equal(attempts, 2);

  const failing = {
    from: () => ({
      upsert: async () => ({
        status: 400,
        error: { code: "PGRST400", message: "payload remoto sigiloso" },
      }),
    }),
  };
  await assert.rejects(
    () =>
      upsertRows({
        client: failing,
        table: "raw_test",
        rows: [{ external_id: "1", payload: {} }],
        maxAttempts: 2,
        baseMs: 1,
        maxMs: 1,
      }),
    (error) =>
      error.response?.status === 400 &&
      !error.message.includes("payload remoto sigiloso"),
  );
});
