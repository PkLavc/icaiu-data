const crypto = require("crypto");
const GoogleSheets = require("../../google/sheets");
const formatPublicError = require("../../lib/public-error");
const getHabllaClient = require("../api");

const TIME_ZONE = "America/Sao_Paulo";
const SERVICE_POPULATE = [
  "person",
  "user",
  "connection",
  "sector",
  "session",
  "reason",
  "tags",
  "finished_by_user",
  "service_times",
].join(",");

const SHEETS = Object.freeze({
  atendimentos: { title: "Atendimentos_Base", dateColumn: "A", width: 28, headerRows: 1, writeSegments: [[0, 25], [26, 28]] },
  atendentes: { title: "Atendentes_Base", dateColumn: "A", width: 19, headerRows: 1, writeSegments: [[0, 18]] },
  cards: { title: "Cartões_Base", dateColumn: "C", width: 51, headerRows: 2, writeSegments: [[0, 50]] },
});

function required(value, name) {
  if (!value) throw new Error(`${name} ausente`);
  return value;
}

function nonNegativeInteger(value, fallback, name) {
  const selected = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(selected);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} precisa ser inteiro >= 0`);
  }
  return parsed;
}

function positiveInteger(value, fallback, name) {
  const parsed = nonNegativeInteger(value, fallback, name);
  if (parsed < 1) throw new Error(`${name} precisa ser inteiro >= 1`);
  return parsed;
}

function selectedDatasets(value) {
  const allowed = new Set(["atendimentos", "atendentes", "cards"]);
  const items = String(value || "atendimentos,atendentes,cards")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length || items.some((item) => !allowed.has(item))) {
    throw new Error("LOJA_PREFERENCIA_DATASETS aceita atendimentos, atendentes e cards");
  }
  return new Set(items);
}

function isoDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(day, amount) {
  const match = String(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Data invalida: ${day}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount, 12));
  return date.toISOString().slice(0, 10);
}

function previousLocalDay() {
  return addDays(isoDay(), -1);
}

function localDayBounds(day) {
  return {
    start: new Date(`${day}T00:00:00.000-03:00`).toISOString(),
    end: new Date(`${day}T23:59:59.999-03:00`).toISOString(),
  };
}

function parseDay(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const instant = new Date(text);
    return Number.isNaN(instant.getTime()) ? null : isoDay(instant);
  }
  match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : isoDay(date);
}

function validateDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`${name} precisa usar YYYY-MM-DD`);
  }
  return String(value);
}

function daySequence(startDay, endDay) {
  const result = [];
  for (let day = startDay; day <= endDay; day = addDays(day, 1)) result.push(day);
  return result;
}

function dateTimeParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values;
}

function formatDateTime(value) {
  const parts = dateTimeParts(value);
  if (!parts) return "";
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatDate(value) {
  const parts = dateTimeParts(value);
  if (!parts) return "";
  return `${parts.day}/${parts.month}/${parts.year}`;
}

function dateCellMdy(value) {
  const formatted = formatDate(value);
  return formatted ? GoogleSheets.dateCell(formatted, { pattern: "m/d/yyyy" }) : "-";
}

function monthFromDay(day) {
  return Number(String(day).slice(5, 7));
}

function latestDay(values, cutoffDay) {
  let latest = null;
  for (const row of values || []) {
    const day = parseDay(Array.isArray(row) ? row[0] : row);
    if (day && day <= cutoffDay && (!latest || day > latest)) latest = day;
  }
  return latest;
}

function startDayForDataset({ values, cutoffDay, forcedDay, fallbackDay, lookbackDays, reconcileDays = 0 }) {
  if (forcedDay) return validateDay(forcedDay, "Data inicial");
  if (reconcileDays > 0) return addDays(cutoffDay, -reconcileDays);
  const last = latestDay(values, cutoffDay);
  if (last) return addDays(last, -lookbackDays);
  if (fallbackDay) return validateDay(fallbackDay, "LOJA_PREFERENCIA_FROM");
  throw new Error("Nao foi encontrada data anterior na planilha; configure LOJA_PREFERENCIA_FROM=YYYY-MM-DD");
}

function resultsFrom(response, dataset) {
  const payload = response?.data;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
    throw new Error(`Hablla retornou ${dataset} em formato inesperado`);
  }
  const invalid = payload.results.findIndex((item) => !item || typeof item !== "object" || Array.isArray(item));
  if (invalid !== -1) throw new Error(`Hablla retornou item invalido em ${dataset}`);
  return payload.results;
}

function safeText(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function jsonCell(value) {
  return value === null || value === undefined || value === ""
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}

function boolPt(value) {
  return value === true ? "VERDADEIRO" : value === false ? "FALSO" : "-";
}

function secondsToHms(value, { zeroAsDash = false } = {}) {
  if (value === null || value === undefined || value === "") return "-";
  const seconds = Math.max(0, Math.round(Number(value)));
  if (!Number.isFinite(seconds) || (seconds === 0 && zeroAsDash)) return "-";
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function durationCell(value, { zeroAsDash = false } = {}) {
  const text = secondsToHms(value, { zeroAsDash });
  if (text === "-") return text;
  const hours = Number(text.split(":")[0]);
  return hours <= 23 ? GoogleSheets.timeCell(text) : text;
}

function totalDurationCell(values) {
  let hasAny = false;
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    hasAny = true;
    total += Math.max(0, number);
  }
  return hasAny ? durationCell(total) : "-";
}

function sumDurations(values) {
  let hasAny = false;
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    hasAny = true;
    total += Math.max(0, number);
  }
  return hasAny ? secondsToHms(total) : "-";
}

function statusPt(status) {
  return ({
    pending: "Pendente",
    in_queue: "Em fila",
    in_attendance: "Em atendimento",
    in_bot: "Em BOT",
    feedback: "Feedback",
    finished: "Finalizado",
  })[status] || safeText(status);
}

function firstEmail(person) {
  const email = person?.emails?.[0];
  return !email ? "-" : typeof email === "string" ? email : email.email || "-";
}

function firstPhone(person) {
  const phone = person?.phones?.[0];
  return !phone ? "-" : typeof phone === "string" ? phone : phone.phone || "-";
}

function tagNames(tags) {
  if (!Array.isArray(tags) || !tags.length) return "-";
  const names = tags
    .map((tag) => (typeof tag === "string" ? tag : tag?.name || tag?.id || ""))
    .filter(Boolean);
  return names.length ? names.join(", ") : "-";
}

function serviceToRow(service) {
  const person = service.person && typeof service.person === "object" ? service.person : null;
  const connection = service.connection && typeof service.connection === "object" ? service.connection : null;
  const sector = service.sector && typeof service.sector === "object" ? service.sector : null;
  const user = service.user && typeof service.user === "object" ? service.user : null;
  const finishedBy = service.finished_by_user && typeof service.finished_by_user === "object" ? service.finished_by_user : null;
  const reason = service.reason && typeof service.reason === "object" ? service.reason : null;
  const session = service.session && typeof service.session === "object" ? service.session : null;
  const times = service.service_times || {};
  const bot = times.bot_total_time;
  const queue = times.queue_total_time;
  const firstResponse = times.first_response_time ?? times.attendance_first_response_time;
  const attendance = times.attendance_total_time;
  const createdText = formatDateTime(service.created_at);
  if (!createdText) throw new Error("Hablla retornou atendimento sem created_at valido");
  const createdDay = parseDay(createdText);
  const time = createdText.slice(11, 19);

  return [
    GoogleSheets.dateTimeCell(createdText, { pattern: "dd/mm/yyyy hh:mm" }),
    safeText(service.name || person?.name),
    firstPhone(person),
    firstEmail(person),
    durationCell(bot, { zeroAsDash: true }),
    durationCell(queue, { zeroAsDash: true }),
    durationCell(firstResponse, { zeroAsDash: true }),
    durationCell(attendance, { zeroAsDash: true }),
    totalDurationCell([bot, queue, firstResponse, attendance]),
    statusPt(service.status),
    safeText(sector?.name),
    safeText(connection?.name),
    safeText(connection?.key),
    safeText(connection?.type || service.type),
    safeText(user?.name),
    safeText(reason?.name),
    safeText(finishedBy?.name),
    safeText(service.csat),
    safeText(service.nps),
    safeText(session?.category),
    boolPt(session?.user_initiated),
    boolPt(session?.two_way_enable),
    dateCellMdy(session?.expire_at),
    tagNames(service.tags),
    safeText(service.summary),
    monthFromDay(createdDay),
    GoogleSheets.dateCell(createdText.slice(0, 10)),
    GoogleSheets.timeCell(time),
  ];
}

function attendantToRow(item, day) {
  const user = item.user || {};
  const sector = item.sector || {};
  const connection = item.connection || {};
  const attendantId = user.id || item.attendant_id || item.id || "";
  return [
    day,
    attendantId,
    `attendant-${day}-${attendantId}`,
    connection.id || "",
    connection.key || "",
    connection.name || "",
    connection.type || "",
    item.csat ?? "",
    sector.color || "",
    sector.id || "",
    sector.name || "",
    item.tma ?? "",
    item.tme ?? "",
    item.total_services ?? "",
    user.email || "",
    user.id || "",
    user.name || "",
    user.photo_url || "",
    monthFromDay(day),
  ];
}

function objectId(value) {
  const text = String(value || "").trim();
  return /^[a-f0-9]{24}$/i.test(text) ? text : null;
}

function scalarId(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value.id || value._id || "";
  return value || "";
}

function customFieldValue(customFields, id) {
  if (!id || !Array.isArray(customFields)) return "";
  const field = customFields.find((item) => String(item?.custom_field || "") === String(id));
  if (!field) return "";
  const value = field.value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : value;
}

function cardToRow(card, customFieldHeaders = []) {
  const board = scalarId(card.board);
  const list = scalarId(card.list);
  const sector = scalarId(card.sector);
  const user = scalarId(card.user);
  const workspace = scalarId(card.workspace);
  const createdDay = parseDay(card.created_at);
  if (!createdDay) throw new Error("Hablla retornou card sem created_at valido");
  const base = [
    card.id || "",
    card.id ? `card-${card.id}` : "",
    card.created_at || "",
    card.updated_at || "",
    card.moved_at || "",
    card.name || "",
    card.additional_discount_value ?? "",
    board,
    card.board_id || board,
    jsonCell(card.checklist || []),
    jsonCell(card.custom_fields || []),
    card.description || "",
    card.discount_value ?? "",
    card.finished_at || "",
    jsonCell(card.followers || []),
    card.id || "",
    list,
    card.list_id || list,
    jsonCell(card.moves || []),
    card.organization_id || "",
    jsonCell(card.persons || []),
    jsonCell(card.previous_cards || []),
    jsonCell(card.products || []),
    card.rating ?? "",
    card.recurring_value ?? "",
    sector,
    card.sector_id || sector,
    card.shipping_value ?? "",
    card.source || "",
    card.status || "",
    card.std_name || "",
    jsonCell(card.tags || []),
    card.taxes_value ?? "",
    card.user_id || user,
    card.value ?? "",
    workspace,
    card.workspace_id || workspace,
  ];
  const customValues = Array.from({ length: 13 }, (_, index) =>
    customFieldValue(card.custom_fields, customFieldHeaders[index]),
  );
  return [...base, ...customValues, monthFromDay(createdDay)];
}

function contiguousBlocks(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const blocks = [];
  for (const index of sorted) {
    const last = blocks.at(-1);
    if (last && index === last.end + 1) last.end = index;
    else blocks.push({ start: index, end: index });
  }
  return blocks;
}

function bodyRowsFromColumns(columns) {
  const length = Math.max(0, ...columns.map((column) => column.length));
  return Array.from({ length }, (_, rowIndex) =>
    columns.map((column) => column[rowIndex]?.[0] ?? ""),
  );
}

async function readBodyColumns(sheets, title, columns, startRow = 2) {
  const ranges = columns.map((column) => `'${title.replace(/'/g, "''")}'!${column}${startRow}:${column}`);
  const values = await sheets.getValuesBatch(ranges);
  return bodyRowsFromColumns(values);
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function stagingChunks(rows, width) {
  const maxRows = positiveInteger(
    process.env.LOJA_PREFERENCIA_SHEETS_CHUNK_ROWS,
    200,
    "LOJA_PREFERENCIA_SHEETS_CHUNK_ROWS",
  );
  const maxBytes = positiveInteger(
    process.env.LOJA_PREFERENCIA_SHEETS_CHUNK_BYTES,
    1500000,
    "LOJA_PREFERENCIA_SHEETS_CHUNK_BYTES",
  );
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  let startIndex = 0;

  for (const row of rows) {
    const rowData = {
      values: Array.from({ length: width }, (_, index) =>
        GoogleSheets.literalCell(row[index]),
      ),
    };
    const bytes = Buffer.byteLength(JSON.stringify(rowData), "utf8");
    if (bytes > maxBytes) {
      throw new Error("Uma linha excede o tamanho seguro da escrita no Google Sheets");
    }
    if (current.length && (current.length >= maxRows || currentBytes + bytes > maxBytes)) {
      chunks.push({ startIndex, rows: current });
      startIndex += current.length;
      current = [];
      currentBytes = 0;
    }
    current.push(rowData);
    currentBytes += bytes;
  }
  if (current.length) chunks.push({ startIndex, rows: current });
  return chunks;
}

async function replaceDayRows({
  sheets,
  sheetId,
  sheetTitle,
  gridRowCount,
  headerRows = 1,
  bodyState,
  day,
  stateDateIndex = 0,
  newRowDateIndex = 0,
  newRows,
  width,
  writeSegments = [[0, width]],
}) {
  const targetIndexes = [];
  for (let index = 0; index < bodyState.length; index += 1) {
    if (parseDay(bodyState[index][stateDateIndex]) === day) targetIndexes.push(index);
  }
  for (const row of newRows) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error(`${sheetTitle}: linha nova com largura invalida`);
    }
    if (parseDay(row[newRowDateIndex]) !== day) {
      throw new Error(`${sheetTitle}: linha nova fora do dia ${day}`);
    }
  }
  if (!newRows.length && !targetIndexes.length) {
    console.log(`[${sheetTitle}] ${day}: sem linhas na origem ou no destino.`);
    return { bodyState, gridRowCount };
  }

  const matched = new Set(targetIndexes);
  const remaining = bodyState.filter((_, index) => !matched.has(index));
  const startRowIndex = headerRows + remaining.length;
  const rowCountAfterDelete = gridRowCount - targetIndexes.length;
  const neededRowCount = headerRows + remaining.length + newRows.length;
  const stagingTitle = `_lp_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  let stagingSheetId = null;
  let promoted = false;

  try {
    const created = await sheets.batchUpdate([
      {
        addSheet: {
          properties: {
            title: stagingTitle,
            hidden: true,
            gridProperties: {
              rowCount: Math.max(1, newRows.length),
              columnCount: width,
            },
          },
        },
      },
    ]);
    stagingSheetId = created.replies?.[0]?.addSheet?.properties?.sheetId;
    if (!Number.isInteger(stagingSheetId)) {
      throw new Error(`${sheetTitle}: Google Sheets nao retornou o ID da staging`);
    }

    for (const chunk of stagingChunks(newRows, width)) {
      await sheets.batchUpdate(
        [
          {
            updateCells: {
              start: {
                sheetId: stagingSheetId,
                rowIndex: chunk.startIndex,
                columnIndex: 0,
              },
              rows: chunk.rows,
              fields: "userEnteredValue,userEnteredFormat.numberFormat",
            },
          },
        ],
        { idempotent: true },
      );
    }

    const stagedDates = await sheets.getValues(
      `${quoteSheetTitle(stagingTitle)}!${columnLetter(newRowDateIndex)}1:${columnLetter(newRowDateIndex)}${newRows.length}`,
    );
    if (
      stagedDates.length !== newRows.length ||
      stagedDates.some((row) => parseDay(row?.[0]) !== day)
    ) {
      throw new Error(`${sheetTitle}: validacao da staging falhou para ${day}`);
    }

    const promotionRequests = contiguousBlocks(targetIndexes)
      .reverse()
      .map((block) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: block.start + headerRows,
            endIndex: block.end + headerRows + 1,
          },
        },
      }));
    if (neededRowCount > rowCountAfterDelete) {
      promotionRequests.push({
        appendDimension: {
          sheetId,
          dimension: "ROWS",
          length: neededRowCount - rowCountAfterDelete,
        },
      });
    }
    for (const [startColumnIndex, endColumnIndex] of writeSegments) {
      if (
        !Number.isInteger(startColumnIndex) ||
        !Number.isInteger(endColumnIndex) ||
        startColumnIndex < 0 ||
        endColumnIndex <= startColumnIndex ||
        endColumnIndex > width
      ) {
        throw new Error(`${sheetTitle}: segmento de escrita invalido`);
      }
      promotionRequests.push({
        copyPaste: {
          source: {
            sheetId: stagingSheetId,
            startRowIndex: 0,
            endRowIndex: newRows.length,
            startColumnIndex,
            endColumnIndex,
          },
          destination: {
            sheetId,
            startRowIndex,
            endRowIndex: startRowIndex + newRows.length,
            startColumnIndex,
            endColumnIndex,
          },
          pasteType: "PASTE_NORMAL",
          pasteOrientation: "NORMAL",
        },
      });
    }

    await sheets.batchUpdate(promotionRequests);
    promoted = true;

    const targetStartRow = startRowIndex + 1;
    const targetEndRow = startRowIndex + newRows.length;
    const dateColumn = columnLetter(newRowDateIndex);
    const writtenDates = await sheets.getValues(
      `${quoteSheetTitle(sheetTitle)}!${dateColumn}${targetStartRow}:${dateColumn}${targetEndRow}`,
    );
    if (
      writtenDates.length !== newRows.length ||
      writtenDates.some((row) => parseDay(row?.[0]) !== day)
    ) {
      throw new Error(`${sheetTitle}: validacao apos promocao falhou para ${day}`);
    }

    const selectors = newRows.map((row) => [row[newRowDateIndex]]);
    const nextState = [...remaining, ...selectors];
    console.log(`[${sheetTitle}] ${day}: ${targetIndexes.length} linhas substituidas por ${newRows.length}.`);
    return {
      bodyState: nextState,
      gridRowCount: Math.max(rowCountAfterDelete, neededRowCount),
    };
  } finally {
    if (stagingSheetId !== null) {
      try {
        await sheets.batchUpdate([{ deleteSheet: { sheetId: stagingSheetId } }]);
      } catch (cleanupError) {
        if (!promoted) {
          console.warn(`[${sheetTitle}] staging temporaria nao pode ser removida apos falha.`);
        }
      }
    }
  }
}

async function fetchServices(hablla, workspaceId, startDay, endDay) {
  const servicesById = new Map();
  const safePages = positiveInteger(process.env.LOJA_PREFERENCIA_SERVICES_SAFE_PAGES, 180, "LOJA_PREFERENCIA_SERVICES_SAFE_PAGES");
  const maxPages = positiveInteger(process.env.LOJA_PREFERENCIA_SERVICES_MAX_PAGES, 1000, "LOJA_PREFERENCIA_SERVICES_MAX_PAGES");
  const start = localDayBounds(startDay).start;
  const end = localDayBounds(endDay).end;

  async function fetchWindow(windowStart, windowEnd) {
    const params = (page) => ({
      start_date: windowStart,
      end_date: windowEnd,
      field_date: "created_at",
      order: "created_at",
      direction_order: "asc",
      populate: SERVICE_POPULATE,
      limit: 50,
      page,
    });
    const first = await hablla.get(`/v2/workspaces/${workspaceId}/services`, { params: params(1) });
    const totalPages = Number(first.data?.totalPages || 0);
    if (totalPages > safePages) {
      const startMs = new Date(windowStart).getTime();
      const endMs = new Date(windowEnd).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 2) {
        throw new Error("Muitos atendimentos no mesmo instante; use o endpoint de exportacao da Hablla");
      }
      const middle = Math.floor((startMs + endMs) / 2);
      await fetchWindow(new Date(startMs).toISOString(), new Date(middle).toISOString());
      await fetchWindow(new Date(middle + 1).toISOString(), new Date(endMs).toISOString());
      return;
    }
    if (totalPages > maxPages) throw new Error(`Janela de atendimentos excede ${maxPages} paginas`);
    const pages = Math.max(1, totalPages);
    for (let page = 1; page <= pages; page += 1) {
      const response = page === 1 ? first : await hablla.get(`/v2/workspaces/${workspaceId}/services`, { params: params(page) });
      const items = resultsFrom(response, "atendimentos");
      for (const service of items) {
        const id = String(service.id || "");
        if (!id) throw new Error("Hablla retornou atendimento sem id");
        servicesById.set(id, service);
      }
      if (page % 25 === 0 || page === pages) {
        console.log(`[atendimentos] pagina ${page}/${pages}; ${servicesById.size} IDs unicos acumulados.`);
      }
    }
  }

  await fetchWindow(start, end);
  return [...servicesById.values()].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

async function fetchAttendantsDay(hablla, workspaceId, day) {
  const range = localDayBounds(day);
  const response = await hablla.get(`/v1/workspaces/${workspaceId}/reports/services/summary`, {
    params: { start_date: range.start, end_date: range.end },
  });
  const items = resultsFrom(response, "atendentes");
  const byKey = new Map();
  for (const item of items) {
    const row = attendantToRow(item, day);
    if (row[1]) byKey.set(row[2], row);
  }
  return [...byKey.values()];
}

function listIdFromCard(card) {
  return objectId(scalarId(card?.list)) || objectId(card?.list_id);
}

async function discoverCardListIds(sheets, hablla, workspaceId, boardId) {
  const ids = new Set();
  const existing = await sheets.getValuesBatch([
    "'Cartões_Base'!Q3:Q",
    "'Cartões_Base'!R3:R",
  ]);
  for (const column of existing) {
    for (const row of column) {
      const id = objectId(row?.[0]);
      if (id) ids.add(id);
    }
  }

  const configured = String(process.env.LOJA_PREFERENCIA_CARD_LIST_IDS || "")
    .split(",")
    .map((value) => objectId(value))
    .filter(Boolean);
  configured.forEach((id) => ids.add(id));

  const discoveryPages = positiveInteger(process.env.LOJA_PREFERENCIA_CARD_LIST_DISCOVERY_PAGES, 20, "LOJA_PREFERENCIA_CARD_LIST_DISCOVERY_PAGES");
  for (let page = 1; page <= discoveryPages; page += 1) {
    const response = await hablla.get(`/v2/workspaces/${workspaceId}/cards`, {
      params: { board: boardId, page, limit: 50, order: "updated_at", direction_order: "desc" },
    });
    const cards = resultsFrom(response, "cards");
    cards.forEach((card) => {
      const id = listIdFromCard(card);
      if (id) ids.add(id);
    });
    if (!cards.length) break;
  }
  if (!ids.size) throw new Error("Nenhum ID de lista valido foi encontrado para os cards");
  console.log(`[cards] ${ids.size} listas identificadas para o board.`);
  return [...ids];
}

function cardCreatedInDay(card, day) {
  return parseDay(card?.created_at) === day;
}

function cardFilterRange(day) {
  // Hablla interprets date-only bounds independently of America/Sao_Paulo.
  // Query two calendar days and keep only cards whose created_at belongs
  // to the target Sao Paulo day. This covers the UTC boundary safely.
  return { start_date: day, end_date: addDays(day, 2) };
}

async function fetchCardListPass(hablla, workspaceId, listId, day, direction) {
  const range = cardFilterRange(day);
  const params = (page) => ({
    list: listId,
    start_date: range.start_date,
    end_date: range.end_date,
    page,
    limit: 50,
    order: "created_at",
    direction_order: direction,
  });
  const first = await hablla.get(`/v2/workspaces/${workspaceId}/cards`, { params: params(1) });
  const totalPages = Math.max(1, Number(first.data?.totalPages || 1));
  const maxPages = positiveInteger(process.env.LOJA_PREFERENCIA_CARDS_MAX_PAGES_PER_LIST_DAY, 200, "LOJA_PREFERENCIA_CARDS_MAX_PAGES_PER_LIST_DAY");
  if (totalPages > maxPages) {
    throw new Error(`Uma lista de cards em ${day} exige ${totalPages} paginas; limite seguro=${maxPages}`);
  }
  const byId = new Map();
  let occurrences = 0;
  let outside = 0;
  for (let page = 1; page <= totalPages; page += 1) {
    const response = page === 1 ? first : await hablla.get(`/v2/workspaces/${workspaceId}/cards`, { params: params(page) });
    const cards = resultsFrom(response, "cards");
    occurrences += cards.length;
    for (const card of cards) {
      const id = String(card.id || "");
      if (!id) throw new Error("Hablla retornou card sem id");
      if (!cardCreatedInDay(card, day)) {
        outside += 1;
        continue;
      }
      const updatedAt = new Date(card.updated_at || card.created_at).getTime();
      const current = byId.get(id);
      if (!current || updatedAt >= current.updatedAt) byId.set(id, { card, updatedAt });
    }
  }
  const totalItems = Number(first.data?.totalItems || 0);
  if (totalItems && occurrences < totalItems) {
    throw new Error(`API de cards informou ${totalItems} ocorrencias, mas retornou ${occurrences}`);
  }
  return { byId, occurrences, outside, totalItems, totalPages };
}

function sameIdSet(left, right) {
  if (left.size !== right.size) return false;
  for (const id of left.keys()) if (!right.has(id)) return false;
  return true;
}

async function fetchCardsForDay(hablla, workspaceId, listIds, day) {
  const all = new Map();
  for (let index = 0; index < listIds.length; index += 1) {
    const listId = listIds[index];
    const desc = await fetchCardListPass(hablla, workspaceId, listId, day, "desc");
    const asc = await fetchCardListPass(hablla, workspaceId, listId, day, "asc");
    if (!sameIdSet(desc.byId, asc.byId)) {
      throw new Error(`Cards instaveis na lista ${index + 1} em ${day}: DESC=${desc.byId.size}, ASC=${asc.byId.size}`);
    }
    for (const [id, item] of desc.byId) {
      const alternative = asc.byId.get(id);
      const selected = alternative && alternative.updatedAt > item.updatedAt ? alternative : item;
      const current = all.get(id);
      if (!current || selected.updatedAt >= current.updatedAt) all.set(id, selected);
    }
    console.log(
      `[cards] ${day} lista ${index + 1}/${listIds.length}: ${desc.byId.size} IDs unicos ` +
      `(totalItems=${desc.totalItems}, paginas=${desc.totalPages}, fora-da-janela=${desc.outside}).`,
    );
  }
  return [...all.values()].map(({ card }) => card);
}

function assertReplacementIsSafe(bodyState, stateDateIndex, day, newRows, dataset) {
  const existing = bodyState.filter((row) => parseDay(row[stateDateIndex]) === day).length;
  if (!newRows.length && existing) {
    throw new Error(`${dataset}: API retornou zero linhas em ${day}, mas a planilha possui ${existing}; substituicao cancelada`);
  }
  return existing;
}

async function syncAtendimentos(context) {
  const { sheets, hablla, workspaceId, sheetProperties, cutoffDay, fallbackFrom, lookbackDays, reconcileDays } = context;
  const title = SHEETS.atendimentos.title;
  const properties = required(sheetProperties[title], `Aba ${title}`);
  let bodyState = await readBodyColumns(sheets, title, ["A"], 2);
  const forced = process.env.LOJA_PREFERENCIA_ATENDIMENTOS_FROM || process.env.LOJA_PREFERENCIA_FROM;
  const startDay = startDayForDataset({ values: bodyState, cutoffDay, forcedDay: forced, fallbackDay: fallbackFrom, lookbackDays, reconcileDays });
  if (startDay > cutoffDay) return;
  console.log(`[atendimentos] sincronizando ${startDay} ate ${cutoffDay}.`);
  const services = await fetchServices(hablla, workspaceId, startDay, cutoffDay);
  const byDay = new Map(daySequence(startDay, cutoffDay).map((day) => [day, []]));
  for (const service of services) {
    const day = parseDay(service.created_at);
    if (byDay.has(day)) byDay.get(day).push(serviceToRow(service));
  }
  let gridRowCount = Number(properties.gridProperties?.rowCount || 1);
  for (const day of daySequence(startDay, cutoffDay)) {
    const rows = byDay.get(day);
    assertReplacementIsSafe(bodyState, 0, day, rows, "atendimentos");
    const result = await replaceDayRows({
      sheets,
      sheetId: properties.sheetId,
      sheetTitle: title,
      gridRowCount,
      headerRows: SHEETS.atendimentos.headerRows,
      bodyState,
      day,
      stateDateIndex: 0,
      newRowDateIndex: 0,
      newRows: rows,
      width: SHEETS.atendimentos.width,
      writeSegments: SHEETS.atendimentos.writeSegments,
    });
    bodyState = result.bodyState;
    gridRowCount = result.gridRowCount;
  }
}

async function syncAtendentes(context) {
  const { sheets, hablla, workspaceId, sheetProperties, cutoffDay, fallbackFrom, lookbackDays, reconcileDays } = context;
  const title = SHEETS.atendentes.title;
  const properties = required(sheetProperties[title], `Aba ${title}`);
  let bodyState = await readBodyColumns(sheets, title, ["A"], 2);
  const forced = process.env.LOJA_PREFERENCIA_ATENDENTES_FROM || process.env.LOJA_PREFERENCIA_FROM;
  const startDay = startDayForDataset({ values: bodyState, cutoffDay, forcedDay: forced, fallbackDay: fallbackFrom, lookbackDays, reconcileDays });
  if (startDay > cutoffDay) return;
  console.log(`[atendentes] sincronizando ${startDay} ate ${cutoffDay}.`);
  let gridRowCount = Number(properties.gridProperties?.rowCount || 1);
  for (const day of daySequence(startDay, cutoffDay)) {
    const rows = await fetchAttendantsDay(hablla, workspaceId, day);
    assertReplacementIsSafe(bodyState, 0, day, rows, "atendentes");
    const result = await replaceDayRows({
      sheets,
      sheetId: properties.sheetId,
      sheetTitle: title,
      gridRowCount,
      headerRows: SHEETS.atendentes.headerRows,
      bodyState,
      day,
      stateDateIndex: 0,
      newRowDateIndex: 0,
      newRows: rows,
      width: SHEETS.atendentes.width,
      writeSegments: SHEETS.atendentes.writeSegments,
    });
    bodyState = result.bodyState;
    gridRowCount = result.gridRowCount;
  }
}

async function syncCards(context) {
  const { sheets, hablla, workspaceId, boardId, sheetProperties, cutoffDay, fallbackFrom, lookbackDays, reconcileDays } = context;
  const title = SHEETS.cards.title;
  const properties = required(sheetProperties[title], `Aba ${title}`);
  let bodyState = await readBodyColumns(sheets, title, ["C"], 3);
  const forced = process.env.LOJA_PREFERENCIA_CARDS_FROM || process.env.LOJA_PREFERENCIA_FROM;
  const startDay = startDayForDataset({ values: bodyState, cutoffDay, forcedDay: forced, fallbackDay: fallbackFrom, lookbackDays, reconcileDays });
  if (startDay > cutoffDay) return;
  const customHeaderRows = await sheets.getValues("'Cartões_Base'!AL1:AX1");
  const customHeaders = Array.from({ length: 13 }, (_, index) => String(customHeaderRows[0]?.[index] || "").trim());
  const listIds = await discoverCardListIds(sheets, hablla, workspaceId, boardId);
  console.log(`[cards] sincronizando ${startDay} ate ${cutoffDay}.`);
  let gridRowCount = Number(properties.gridProperties?.rowCount || 1);
  for (const day of daySequence(startDay, cutoffDay)) {
    const cards = await fetchCardsForDay(hablla, workspaceId, listIds, day);
    const rows = cards
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
      .map((card) => cardToRow(card, customHeaders));
    const existingCardsForDay = bodyState.filter((row) => parseDay(row[0]) === day).length;
    if (!rows.length && existingCardsForDay) {
      console.warn(
        `[cards] ${day}: API retornou zero, mas existem ${existingCardsForDay} linhas; preservando o dia existente e continuando a reconciliacao.`,
      );
      continue;
    }
    assertReplacementIsSafe(bodyState, 0, day, rows, "cards");
    const result = await replaceDayRows({
      sheets,
      sheetId: properties.sheetId,
      sheetTitle: title,
      gridRowCount,
      headerRows: SHEETS.cards.headerRows,
      bodyState,
      day,
      stateDateIndex: 0,
      newRowDateIndex: 2,
      newRows: rows,
      width: SHEETS.cards.width,
      writeSegments: SHEETS.cards.writeSegments,
    });
    bodyState = result.bodyState;
    gridRowCount = result.gridRowCount;
  }
}


function validationStartDay(cutoffDay, days) {
  if (!Number.isInteger(days) || days < 1) return null;
  return addDays(cutoffDay, -(days - 1));
}

function emptyDayCounts(startDay, endDay) {
  return new Map(daySequence(startDay, endDay).map((day) => [day, 0]));
}

function countRowsByDay(values, startDay, endDay) {
  const counts = emptyDayCounts(startDay, endDay);
  for (const row of values || []) {
    const day = parseDay(Array.isArray(row) ? row[0] : row);
    if (day && counts.has(day)) counts.set(day, counts.get(day) + 1);
  }
  return counts;
}

function countItemsByDay(items, startDay, endDay, getDate) {
  const counts = emptyDayCounts(startDay, endDay);
  for (const item of items || []) {
    const day = parseDay(getDate(item));
    if (day && counts.has(day)) counts.set(day, counts.get(day) + 1);
  }
  return counts;
}

function compareDayCounts(label, sourceCounts, sheetCounts, startDay, endDay) {
  const days = daySequence(startDay, endDay);
  const mismatches = [];
  let sourceTotal = 0;
  let sheetTotal = 0;

  for (const day of days) {
    const source = Number(sourceCounts.get(day) || 0);
    const sheet = Number(sheetCounts.get(day) || 0);
    sourceTotal += source;
    sheetTotal += sheet;
    if (source !== sheet) mismatches.push({ day, source, sheet });
  }

  console.log(
    `[validacao-30d] ${label}: Hablla=${sourceTotal}, planilha=${sheetTotal}, dias=${days.length}, divergencias=${mismatches.length}.`,
  );

  if (mismatches.length) {
    const sample = mismatches
      .slice(0, 12)
      .map((item) => `${item.day}:Hablla=${item.source}/planilha=${item.sheet}`)
      .join(", ");
    throw new Error(
      `Validacao de ${label} falhou nos ultimos ${days.length} dias. Total Hablla=${sourceTotal}, planilha=${sheetTotal}. Divergencias: ${sample}`,
    );
  }

  return { sourceTotal, sheetTotal, days: days.length, mismatches: 0 };
}

async function validateLastDays(context, datasets, validationDays) {
  if (validationDays < 1) return;
  const { sheets, hablla, workspaceId, boardId, cutoffDay } = context;
  const startDay = validationStartDay(cutoffDay, validationDays);
  console.log(
    `[validacao-30d] Conferindo ${validationDays} dias completos: ${startDay} ate ${cutoffDay}.`,
  );

  if (datasets.has("atendimentos")) {
    const source = await fetchServices(hablla, workspaceId, startDay, cutoffDay);
    const sourceCounts = countItemsByDay(
      source,
      startDay,
      cutoffDay,
      (item) => item.created_at,
    );
    const sheetValues = await readBodyColumns(
      sheets,
      SHEETS.atendimentos.title,
      ["A"],
      SHEETS.atendimentos.headerRows + 1,
    );
    const sheetCounts = countRowsByDay(sheetValues, startDay, cutoffDay);
    compareDayCounts("atendimentos", sourceCounts, sheetCounts, startDay, cutoffDay);
  }

  if (datasets.has("atendentes")) {
    const sourceCounts = emptyDayCounts(startDay, cutoffDay);
    for (const day of daySequence(startDay, cutoffDay)) {
      const rows = await fetchAttendantsDay(hablla, workspaceId, day);
      sourceCounts.set(day, rows.length);
    }
    const sheetValues = await readBodyColumns(
      sheets,
      SHEETS.atendentes.title,
      ["A"],
      SHEETS.atendentes.headerRows + 1,
    );
    const sheetCounts = countRowsByDay(sheetValues, startDay, cutoffDay);
    compareDayCounts("atendentes", sourceCounts, sheetCounts, startDay, cutoffDay);
  }

  if (datasets.has("cards")) {
    const listIds = await discoverCardListIds(sheets, hablla, workspaceId, boardId);
    const sourceCounts = emptyDayCounts(startDay, cutoffDay);
    for (const day of daySequence(startDay, cutoffDay)) {
      const cards = await fetchCardsForDay(hablla, workspaceId, listIds, day);
      sourceCounts.set(day, cards.length);
    }
    const sheetValues = await readBodyColumns(
      sheets,
      SHEETS.cards.title,
      ["C"],
      SHEETS.cards.headerRows + 1,
    );
    const sheetCounts = countRowsByDay(sheetValues, startDay, cutoffDay);
    compareDayCounts("cards", sourceCounts, sheetCounts, startDay, cutoffDay);
  }

  console.log(`[validacao-30d] Validacao concluida para os ultimos ${validationDays} dias.`);
}

async function run() {
  try {
    const spreadsheetId = process.env.LOJA_PREFERENCIA_SPREADSHEET_ID || process.env.HABLLA_SPREADSHEET_ID;
    const workspaceId = required(process.env.HABLLA_WORKSPACE_ID, "HABLLA_WORKSPACE_ID");
    const boardId = process.env.HABLLA_BOARD_ID;
    const token = required(process.env.GOOGLE_TOKEN, "GOOGLE_TOKEN");
    required(spreadsheetId, "LOJA_PREFERENCIA_SPREADSHEET_ID/HABLLA_SPREADSHEET_ID");
    const datasets = selectedDatasets(process.env.LOJA_PREFERENCIA_DATASETS);
    if (datasets.has("cards")) required(boardId, "HABLLA_BOARD_ID");
    const cutoffDay = process.env.LOJA_PREFERENCIA_TO
      ? validateDay(process.env.LOJA_PREFERENCIA_TO, "LOJA_PREFERENCIA_TO")
      : previousLocalDay();
    const fallbackFrom = process.env.LOJA_PREFERENCIA_FROM || "";
    const lookbackDays = nonNegativeInteger(process.env.LOJA_PREFERENCIA_LOOKBACK_DAYS, 1, "LOJA_PREFERENCIA_LOOKBACK_DAYS");
    const reconcileDays = nonNegativeInteger(process.env.LOJA_PREFERENCIA_RECONCILE_DAYS, 0, "LOJA_PREFERENCIA_RECONCILE_DAYS");
    const validationDays = nonNegativeInteger(process.env.LOJA_PREFERENCIA_VALIDATE_DAYS, 30, "LOJA_PREFERENCIA_VALIDATE_DAYS");

    const sheets = new GoogleSheets({ spreadsheetId, accessToken: token });
    const sheetProperties = await sheets.getSheetPropertiesByTitle({ forceRefresh: true });
    const hablla = await getHabllaClient();
    const context = { sheets, hablla, workspaceId, boardId, sheetProperties, cutoffDay, fallbackFrom, lookbackDays, reconcileDays };

    if (datasets.has("atendimentos")) await syncAtendimentos(context);
    if (datasets.has("atendentes")) await syncAtendentes(context);
    if (datasets.has("cards")) await syncCards(context);
    await validateLastDays(context, datasets, validationDays);
    console.log("[loja-preferencia] sincronizacao e validacao concluidas.");
  } catch (error) {
    console.error(`[loja-preferencia] falha: ${formatPublicError(error)}`);
    process.exitCode = 1;
  }
}

module.exports = run;
module.exports._internals = {
  SHEETS,
  addDays,
  assertReplacementIsSafe,
  attendantToRow,
  cardToRow,
  cardFilterRange,
  customFieldValue,
  daySequence,
  latestDay,
  parseDay,
  replaceDayRows,
  sameIdSet,
  selectedDatasets,
  serviceToRow,
  startDayForDataset,
  validationStartDay,
  countRowsByDay,
  countItemsByDay,
  compareDayCounts,
};

if (require.main === module) run();
