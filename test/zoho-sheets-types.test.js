const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");
const scheduling = require("../src/zoho/sheets/scheduling");
const leads = require("../src/zoho/sheets/leads");

const NOW = new Date("2026-07-15T15:00:00Z");

test("Zoho Leads usa janela concluida, criterio inclusivo e datas explicitas prioritarias", () => {
  const standard = leads.resolveLeadsWindow({}, NOW);
  assert.equal(standard.startDay, "2026-07-14");
  assert.equal(standard.endDay, "2026-07-14");

  const july = leads.resolveLeadsWindow({
    ZOHO_LEADS_SHEETS_DAYS: "1",
    ZOHO_LEADS_SHEETS_START_DATE: "2026-07-01",
    ZOHO_LEADS_SHEETS_END_DATE: "2026-07-14",
  }, NOW);
  assert.equal(july.days, 14);
  assert.equal(july.startDay, "2026-07-01");
  assert.equal(july.endDay, "2026-07-14");
  assert.equal(
    leads.buildLeadsCriteria(july),
    '(Data_e_hora_de_inicio_do_formul_rio >= "01-Jul-2026 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "14-Jul-2026 23:59:59")',
  );
  for (const value of [
    "01/07/2026 00:00:00",
    "14-07-2026 23:59:59",
    "14-Jul-2026 07:47:00",
  ]) {
    assert.equal(
      leads.isLeadDateInWindow(value, july.startDay, july.endDay),
      true,
    );
  }
  assert.equal(
    leads.isLeadDateInWindow(
      "15/07/2026 00:00:00",
      july.startDay,
      july.endDay,
    ),
    false,
  );
});

test("Zoho Leads repete HTTP 200 malformado e aceita a resposta seguinte", async () => {
  let calls = 0;
  const waits = [];
  const zoho = {
    get: async () => {
      calls += 1;
      if (calls === 1) return { status: 200, data: {} };
      return { status: 200, data: { code: 3000, data: [{ ID: "1" }] } };
    },
  };
  const data = await leads.fetchZohoRecordsPage(
    zoho,
    "https://example.invalid",
    { from: 1, limit: 200 },
    {
      maxAttempts: 3,
      retryDelayMs: 1,
      sleepFn: async (ms) => waits.push(ms),
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1]);
  assert.deepEqual(data, [{ ID: "1" }]);
});

test("Zoho Leads continua falhando se a resposta 200 permanecer invalida", async () => {
  let calls = 0;
  const zoho = {
    get: async () => {
      calls += 1;
      return { status: 200, data: {} };
    },
  };
  await assert.rejects(
    () =>
      leads.fetchZohoRecordsPage(
        zoho,
        "https://example.invalid",
        { from: 1, limit: 200 },
        {
          maxAttempts: 3,
          retryDelayMs: 1,
          sleepFn: async () => {},
        },
      ),
    (error) => error.code === "ZOHO_INVALID_RECORD_LIST",
  );
  assert.equal(calls, 3);
});

test("Zoho Leads deduplica por ID e protege janela existente contra retorno vazio", () => {
  const first = { ID: "1", marker: "antigo" };
  const only = { ID: "2", marker: "unico" };
  const last = { ID: "1", marker: "novo" };
  assert.deepEqual(leads.dedupeZohoRecordsById([first, only, last]), [last, only]);
  assert.throws(() => leads.dedupeZohoRecordsById([{}]), /sem ID/);

  const options = {
    incomingCount: 0,
    existingValues: [["14/07/2026 07:47:00"]],
    startDay: "2026-07-01",
    endDay: "2026-07-14",
    allowEmpty: false,
  };
  assert.throws(
    () => leads.assertNonEmptyWindowReplacement(options),
    /substituicao cancelada/,
  );
  assert.doesNotThrow(() =>
    leads.assertNonEmptyWindowReplacement({ ...options, allowEmpty: true }),
  );
  assert.throws(
    () => leads.resolveLeadsWindow({
      ZOHO_LEADS_SHEETS_START_DATE: "2026-07-01",
      ZOHO_LEADS_SHEETS_END_DATE: "2026-07-15",
    }, NOW),
    /anterior a hoje/,
  );
});

test("Zoho Scheduling preserva o default e permite dias concluidos ou datas explicitas", () => {
  const historical = scheduling.resolveSchedulingWindow({}, NOW);
  assert.equal(historical.mode, "historical-default");
  assert.equal(historical.startDay, "2026-06-01");
  assert.equal(historical.endDay, "2026-07-15");

  const completed = scheduling.resolveSchedulingWindow({
    ZOHO_SCHEDULING_SHEETS_DAYS: "14",
  }, NOW);
  assert.equal(completed.mode, "completed-days");
  assert.equal(completed.startDay, "2026-07-01");
  assert.equal(completed.endDay, "2026-07-14");

  const explicit = scheduling.resolveSchedulingWindow({
    ZOHO_SCHEDULING_SHEETS_DAYS: "1",
    ZOHO_SCHEDULING_SHEETS_START_DATE: "2026-07-03",
    ZOHO_SCHEDULING_SHEETS_END_DATE: "2026-07-10",
  }, NOW);
  assert.equal(explicit.mode, "explicit");
  assert.equal(explicit.startDay, "2026-07-03");
  assert.equal(explicit.endDay, "2026-07-10");
  assert.equal(
    scheduling.buildSchedulingCriteria(explicit),
    '(Data_e_hora_de_inicio_do_formulario >= "03-Jul-2026 00:00:00" && Data_e_hora_de_inicio_do_formulario <= "10-Jul-2026 23:59:59")',
  );
});

test("Zoho Scheduling usa diretamente os nomes claros do repositorio", () => {
  const config = scheduling.resolveSchedulingConfig({
    ZOHO_ACCOUNT_OWNER: "owner",
    ZOHO_SCHEDULING_APP_NAME: "app",
    ZOHO_SCHEDULING_REPORT_NAME: "report",
    ZOHO_SCHEDULING_COLUMN_MAPPING: "[]",
    ZOHO_SCHEDULING_SPREADSHEET_ID: "spreadsheet",
    ZOHO_SCHEDULING_SHEET_NAME: "sheet",
    GOOGLE_TOKEN: "token",
  });
  assert.deepEqual(config, {
    accountOwner: "owner",
    appName: "app",
    reportName: "report",
    spreadsheetId: "spreadsheet",
    sheetName: "sheet",
    columnMapping: "[]",
    googleToken: "token",
  });
});

test("Zoho Scheduling deduplica IDs, rejeita hoje e protege retorno vazio", () => {
  const first = { ID: "1", marker: "antigo" };
  const only = { ID: "2", marker: "unico" };
  const last = { ID: "1", marker: "novo" };
  assert.deepEqual(
    scheduling.dedupeZohoRecordsById([first, only, last]),
    [last, only],
  );
  assert.throws(() => scheduling.dedupeZohoRecordsById([{}]), /sem ID/);
  assert.throws(
    () => scheduling.resolveSchedulingWindow({
      ZOHO_SCHEDULING_SHEETS_START_DATE: "2026-07-01",
      ZOHO_SCHEDULING_SHEETS_END_DATE: "2026-07-15",
    }, NOW),
    /anterior a hoje/,
  );

  const window = scheduling.resolveSchedulingWindow({
    ZOHO_SCHEDULING_SHEETS_DAYS: "14",
  }, NOW);
  const options = {
    incomingCount: 0,
    existingValues: [["14/Jul/2026"]],
    startDate: window.startDate,
    endDate: window.endDate,
    allowEmpty: false,
  };
  assert.throws(
    () => scheduling.assertNonEmptyWindowReplacement(options),
    /substituicao cancelada/,
  );
  assert.doesNotThrow(() =>
    scheduling.assertNonEmptyWindowReplacement({
      ...options,
      allowEmpty: true,
    }),
  );
});

test("Zoho Scheduling aplica apenas os tipos históricos nas colunas previstas", () => {
  const row = Array.from({ length: 34 }, (_, index) => `campo-${index}`);
  row[0] = "5511999999999";
  row[3] = "001234";
  row[4] = "14-Jul-2026 07:47:13";
  row[5] = "14-Jul-2026 08:15:00";
  row[12] = "14-Jul-2026 09:30:45";
  row[16] = "46217001234";
  row[17] = "14/Jul/2026";
  row[18] = "09:30:45";
  row[19] = "14/Jul/2026";
  row[20] = "07:47:13";
  row[21] = 1;
  row[22] = 0;
  row[33] = "Jul/2026";

  const typed = scheduling.applySchedulingTypes(row);

  assert.equal(typed[0], 5511999999999);
  assert.deepEqual(GoogleSheets.literalCell(typed[3]), {
    userEnteredValue: { stringValue: "001234" },
  });
  assert.deepEqual(GoogleSheets.literalCell(typed[16]), {
    userEnteredValue: { stringValue: "46217001234" },
  });
  assert.deepEqual(GoogleSheets.literalCell(typed[4]), {
    userEnteredValue: { numberValue: Number(typed[4]) },
    userEnteredFormat: {
      numberFormat: { type: "DATE_TIME", pattern: "dd-mm-yyyy hh:mm" },
    },
  });
  assert.deepEqual(GoogleSheets.literalCell(typed[12]), {
    userEnteredValue: { numberValue: Number(typed[12]) },
    userEnteredFormat: {
      numberFormat: {
        type: "DATE_TIME",
        pattern: "dd/MM/yyyy HH:mm:ss",
      },
    },
  });
  for (const index of [17, 19]) {
    assert.equal(
      GoogleSheets.literalCell(typed[index]).userEnteredFormat.numberFormat.type,
      "DATE",
    );
  }
  for (const index of [18, 20]) {
    assert.deepEqual(
      GoogleSheets.literalCell(typed[index]).userEnteredFormat.numberFormat,
      { type: "TIME", pattern: "HH:mm:ss" },
    );
  }
  assert.deepEqual(
    GoogleSheets.literalCell(typed[33]).userEnteredFormat.numberFormat,
    { type: "DATE", pattern: "mm/yyyy" },
  );
  assert.equal(String(typed[17]), "14/07/2026");
  assert.equal(typed[2], "campo-2");
  assert.equal(typed[21], 1);
  assert.equal(typed[22], 0);
});

test("Zoho Scheduling remove somente o sinal de mais inicial do telefone", () => {
  assert.equal(scheduling.normalizeSchedulingPhone("+5511999999999"), "5511999999999");
  assert.equal(scheduling.normalizeSchedulingPhone("5511999999999"), "5511999999999");
  assert.equal(scheduling.normalizeSchedulingPhone("11+22"), "11+22");
});

test("Zoho Leads preserva primitivos e converte somente CPF, CEP, R e W", () => {
  assert.equal(leads.extractValue(42), 42);
  assert.equal(leads.extractValue(false), false);
  assert.equal(leads.extractValue({ display_value: 7 }), 7);
  assert.equal(leads.extractValue({ display_value: false }), false);

  const row = Array.from({ length: 29 }, (_, index) => `campo-${index}`);
  row[1] = "01234567890";
  row[2] = "1234";
  row[5] = "01310930";
  row[17] = "14-Jul-2026 07:47:13";
  row[22] = "14-Jul-2026 09:30:45";
  row[23] = 17;
  row[24] = true;

  const typed = leads.applyLeadTypes(row);

  assert.equal(typed[1], 1234567890);
  assert.equal(typed[5], 1310930);
  assert.equal(typed[2], "1234");
  assert.equal(typed[23], 17);
  assert.equal(typed[24], true);
  assert.deepEqual(
    GoogleSheets.literalCell(typed[17]).userEnteredFormat.numberFormat,
    { type: "DATE_TIME", pattern: "dd-mm-yyyy hh:mm:ss" },
  );
  assert.deepEqual(
    GoogleSheets.literalCell(typed[22]).userEnteredFormat.numberFormat,
    { type: "DATE_TIME", pattern: "dd/MM/yyyy HH:mm:ss" },
  );
  for (const index of [17, 22]) {
    assert.ok(String(typed[index]).startsWith("14/07/2026"));
  }
});
