const GoogleSheets = require("../../google/sheets");
const { createIdPageTracker } = require("../../lib/page-progress");
const formatPublicError = require("../../lib/public-error");
const {
  addDays,
  isoDay,
  today: saoPauloToday,
} = require("../../lib/sao-paulo-date");
const createZohoClient = require("../api");
const { extractZohoRecords } = require("../response");
const { sleep } = require("../../lib/http-retry");
const { digitsToNumber, toDateTimeCell } = require("./value-types");

// Função para registrar eventos sem expor dados sensíveis
function secureLog(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logLevel = isError ? "ERROR" : "INFO";
  console.log(`[${timestamp}] [${logLevel}] ${message}`);
}

// Função para impedir Spreadsheet Formula Injection
// Processa campos complexos do Zoho (Lookups, Multi-select, etc)
function extractValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const extracted = value.display_value ?? value.ID;
    if (extracted === null || extracted === undefined || extracted === "") {
      return String(value);
    }
    return typeof extracted === "number" || typeof extracted === "boolean"
      ? extracted
      : String(extracted);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "object" ? v.display_value || v : v))
      .join(", ");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function applyLeadTypes(row) {
  const typed = [...row];
  typed[1] = digitsToNumber(typed[1]);
  typed[5] = digitsToNumber(typed[5]);
  typed[17] = toDateTimeCell(typed[17], {
    pattern: "dd-mm-yyyy hh:mm:ss",
  });
  typed[22] = toDateTimeCell(typed[22], {
    pattern: "dd/MM/yyyy HH:mm:ss",
  });
  return typed;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function positiveIntegerOption(value, fallback, name) {
  const candidate = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return candidate;
}

function parseIsoDayOption(value, name) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${name} precisa usar YYYY-MM-DD`);
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (isoDay(date) !== text) throw new Error(`${name} invalida`);
  return date;
}

function booleanOption(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "sim"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "não"].includes(normalized)) return false;
  throw new Error(`${name} precisa ser true ou false`);
}

async function fetchZohoRecordsPage(
  zoho,
  queryUrl,
  params,
  {
    maxAttempts = 3,
    retryDelayMs = 1000,
    sleepFn = sleep,
    dataset = "leads Sheets",
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await zoho.get(queryUrl, { params });
    try {
      return extractZohoRecords(response, dataset);
    } catch (error) {
      if (error.code !== "ZOHO_INVALID_RECORD_LIST" || attempt === maxAttempts) {
        throw error;
      }
      secureLog(
        `Resposta Zoho invalida; repetindo leitura (${attempt + 1}/${maxAttempts})`,
      );
      await sleepFn(retryDelayMs * attempt);
    }
  }
  throw new Error("Zoho leads nao estabilizou apos retries");
}
function formatZohoDate(date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function resolveLeadsWindow(env = process.env, now = new Date()) {
  const startValue = String(env.ZOHO_LEADS_SHEETS_START_DATE || "").trim();
  const endValue = String(env.ZOHO_LEADS_SHEETS_END_DATE || "").trim();
  const today = saoPauloToday(now);

  let startDate;
  let endDate;
  let explicit = false;
  if (startValue || endValue) {
    if (!startValue || !endValue) {
      throw new Error(
        "ZOHO_LEADS_SHEETS_START_DATE e ZOHO_LEADS_SHEETS_END_DATE devem ser informadas juntas",
      );
    }
    explicit = true;
    startDate = parseIsoDayOption(
      startValue,
      "ZOHO_LEADS_SHEETS_START_DATE",
    );
    endDate = parseIsoDayOption(endValue, "ZOHO_LEADS_SHEETS_END_DATE");
  } else {
    const days = positiveIntegerOption(
      env.ZOHO_LEADS_SHEETS_DAYS,
      1,
      "ZOHO_LEADS_SHEETS_DAYS",
    );
    startDate = addDays(today, -days);
    endDate = addDays(today, -1);
  }

  if (startDate > endDate) throw new Error("Janela Zoho Leads esta invertida");
  if (endDate >= today) {
    throw new Error("ZOHO_LEADS_SHEETS_END_DATE precisa ser anterior a hoje");
  }
  return {
    explicit,
    days: Math.round((endDate - startDate) / 86400000) + 1,
    startDate,
    endDate,
    startDay: isoDay(startDate),
    endDay: isoDay(endDate),
    startZoho: formatZohoDate(startDate),
    endZoho: formatZohoDate(endDate),
  };
}

function parseLeadSheetDay(value) {
  const text = String(value ?? "").trim().replace(/^'/, "");
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\D|$)/);
  if (match) {
    return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\D|$)/);
  if (!match) return null;
  const month = MONTHS.findIndex(
    (candidate) => candidate.toLowerCase() === match[2].toLowerCase(),
  );
  if (month < 0) return null;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function isLeadDateInWindow(value, startDay, endDay) {
  const day = parseLeadSheetDay(value);
  return Boolean(day && day >= startDay && day <= endDay);
}

function buildLeadsCriteria(window) {
  return `(Data_e_hora_de_inicio_do_formul_rio >= "${window.startZoho} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${window.endZoho} 23:59:59")`;
}

function dedupeZohoRecordsById(records, dataset = "Zoho Leads") {
  const unique = new Map();
  for (const record of records) {
    if (record?.ID === undefined || record?.ID === null || record?.ID === "") {
      throw new Error(`${dataset} retornou registro sem ID`);
    }
    unique.set(String(record.ID), record);
  }
  return [...unique.values()];
}

function assertNonEmptyWindowReplacement({
  incomingCount,
  existingValues,
  startDay,
  endDay,
  allowEmpty,
}) {
  if (incomingCount > 0 || allowEmpty) return;
  const existingCount = (Array.isArray(existingValues) ? existingValues : [])
    .filter((row) => isLeadDateInWindow(row?.[0], startDay, endDay)).length;
  if (existingCount > 0) {
    throw new Error(
      `Zoho Leads retornou zero registros para uma janela que possui ${existingCount} linhas; substituicao cancelada`,
    );
  }
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

async function run() {
  const {
    ZOHO_CLIENT_ID,
    ZOHO_ACCOUNT_OWNER,
    ZOHO_LEADS_APP_NAME,
    ZOHO_LEADS_REPORT_NAME,
    ZOHO_LEADS_SPREADSHEET_ID,
    ZOHO_LEADS_SHEET_NAME,
    GOOGLE_TOKEN,
    ZOHO_LEADS_COLUMN_MAPPING,
  } = process.env;
  const SPREADSHEET_ID = ZOHO_LEADS_SPREADSHEET_ID;
  const SHEET_NAME = ZOHO_LEADS_SHEET_NAME;
  const ZOHO_APP_LINK_NAME = ZOHO_LEADS_APP_NAME;
  const ZOHO_REPORT_LINK_NAME = ZOHO_LEADS_REPORT_NAME;
  const COLUMN_MAPPING = ZOHO_LEADS_COLUMN_MAPPING;

  // Validação de variáveis essenciais
  if (
    !ZOHO_CLIENT_ID ||
    !GOOGLE_TOKEN ||
    !COLUMN_MAPPING ||
    !SPREADSHEET_ID ||
    !SHEET_NAME ||
    !ZOHO_ACCOUNT_OWNER ||
    !ZOHO_APP_LINK_NAME ||
    !ZOHO_REPORT_LINK_NAME
  ) {
    throw new Error("Variaveis obrigatorias do Zoho Leads ausentes");
  }

  const mapping = JSON.parse(COLUMN_MAPPING);
  const headers = Object.keys(mapping);
  const dateColumn = Object.values(mapping).findIndex((name) =>
    String(name).includes("Data_e_hora_de_inicio"),
  );
  if (dateColumn < 0) {
    throw new Error(
      "Coluna de data do formulário não encontrada no mapeamento",
    );
  }
  const sheets = new GoogleSheets({
    spreadsheetId: SPREADSHEET_ID,
    accessToken: GOOGLE_TOKEN,
  });

  try {
    secureLog("Iniciando autenticação Zoho");
    const zoho = await createZohoClient();
    secureLog("Autenticação Zoho realizada com sucesso");

    const window = resolveLeadsWindow(process.env);
    secureLog(
      `Filtrando ${window.days} dias concluidos: ${window.startZoho} a ${window.endZoho}`,
    );

    const allRecords = [];
    let fromIndex = 1; // API do Zoho Creator v2 inicia em 1
    const limit = 200;
    let pages = 0;
    const pageTracker = createIdPageTracker({
      source: "Zoho leads Sheets",
      idOf: (record) => record?.ID,
    });
    const maxPages = Number(process.env.ZOHO_MAX_PAGES || 10000);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error("ZOHO_MAX_PAGES precisa ser inteiro >= 1");
    }
    const criteria = buildLeadsCriteria(window);

    // Loop de Captura de Dados com Critério de Data
    while (true) {
      if (++pages > maxPages) throw new Error("Zoho excedeu o limite seguro de paginas");
      const queryUrl = `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_APP_LINK_NAME}/report/${ZOHO_REPORT_LINK_NAME}`;

      secureLog(`Buscando registros: índice ${fromIndex}`);

      try {
        const data = await fetchZohoRecordsPage(
          zoho,
          queryUrl,
          { from: fromIndex, limit: limit, criteria: criteria },
          {
            maxAttempts: positiveIntegerOption(
              process.env.ZOHO_LEADS_SHEETS_RESPONSE_ATTEMPTS,
              3,
              "ZOHO_LEADS_SHEETS_RESPONSE_ATTEMPTS",
            ),
            retryDelayMs: positiveIntegerOption(
              process.env.ZOHO_LEADS_SHEETS_RESPONSE_RETRY_MS,
              1000,
              "ZOHO_LEADS_SHEETS_RESPONSE_RETRY_MS",
            ),
          },
        );
        if (data.length === 0) break;
        pageTracker.observe(dedupeZohoRecordsById(data));

        allRecords.push(...data);

        if (data.length < limit) break; // Se veio menos que o limite, acabou a base
        fromIndex += limit;
      } catch (err) {
        if (Number(err.providerCode) === 3100) {
          secureLog("Fim dos registros alcançado");
          break;
        }
        throw err;
      }
    }

    const uniqueRecords = dedupeZohoRecordsById(allRecords);
    const allProcessed = uniqueRecords.map((record) => {
      const row = Object.values(mapping).map((zohoKey) =>
        extractValue(record[zohoKey]),
      );
      return applyLeadTypes(row);
    });
    if (!allProcessed.length) {
      const dateColumnLetter = columnLetter(dateColumn);
      const escapedSheetName = SHEET_NAME.replace(/'/g, "''");
      const existingDates = await sheets.getValues(
        `'${escapedSheetName}'!${dateColumnLetter}2:${dateColumnLetter}`,
      );
      assertNonEmptyWindowReplacement({
        incomingCount: 0,
        existingValues: existingDates,
        startDay: window.startDay,
        endDay: window.endDay,
        allowEmpty: booleanOption(
          process.env.ZOHO_LEADS_SHEETS_ALLOW_EMPTY_REPLACEMENT,
          false,
          "ZOHO_LEADS_SHEETS_ALLOW_EMPTY_REPLACEMENT",
        ),
      });
    }
    const result = await sheets.replaceRows({
      sheetTitle: SHEET_NAME,
      columnRange: "A:AC",
      header: headers,
      newRows: allProcessed,
      matchColumnIndexes: [dateColumn],
      shouldReplace: (row) =>
        isLeadDateInWindow(
          row[dateColumn],
          window.startDay,
          window.endDay,
        ),
    });
    secureLog(
      `Processo concluído: ${result.removed} removidas e ${result.inserted} inseridas`,
    );
  } catch (e) {
    secureLog(`Falha no processo: ${formatPublicError(e)}`, true);
    throw e;
  }
}

run.applyLeadTypes = applyLeadTypes;
run.extractValue = extractValue;
run.resolveLeadsWindow = resolveLeadsWindow;
run.isLeadDateInWindow = isLeadDateInWindow;
run.buildLeadsCriteria = buildLeadsCriteria;
run.dedupeZohoRecordsById = dedupeZohoRecordsById;
run.assertNonEmptyWindowReplacement = assertNonEmptyWindowReplacement;
run.fetchZohoRecordsPage = fetchZohoRecordsPage;
module.exports = run;

if (require.main === module) {
  run().catch(() => {
    process.exitCode = 1;
  });
}
