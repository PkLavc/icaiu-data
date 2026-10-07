const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../src/hablla/sheets/loja-preferencia');

test('usa os nomes e offsets reais das tres abas', () => {
  assert.equal(_internals.SHEETS.atendimentos.title, 'Atendimentos_Base');
  assert.equal(_internals.SHEETS.atendentes.title, 'Atendentes_Base');
  assert.equal(_internals.SHEETS.cards.title, 'Cartões_Base');
  assert.equal(_internals.SHEETS.cards.headerRows, 2);
  assert.deepEqual(_internals.SHEETS.atendimentos.writeSegments, [[0, 25], [26, 28]]);
  assert.deepEqual(_internals.SHEETS.atendentes.writeSegments, [[0, 18]]);
  assert.deepEqual(_internals.SHEETS.cards.writeSegments, [[0, 50]]);
});

test('detecta datas e retrocede um dia para reconciliacao', () => {
  assert.equal(_internals.parseDay('16/09/2026 10:15'), '2026-09-16');
  assert.equal(_internals.parseDay('2026-10-06T12:00:00Z'), '2026-10-06');
  assert.equal(_internals.parseDay('2026-09-08T01:30:00Z'), '2026-09-07');
  assert.equal(
    _internals.startDayForDataset({
      values: [['15/09/2026'], ['16/09/2026']],
      cutoffDay: '2026-10-06',
      forcedDay: '',
      fallbackDay: '',
      lookbackDays: 1,
    }),
    '2026-09-15',
  );
});

test('reconciliacao fixa usa o corte atual em vez da ultima data da planilha', () => {
  assert.equal(
    _internals.startDayForDataset({
      values: [['2026-09-15']],
      cutoffDay: '2026-10-06',
      forcedDay: '',
      fallbackDay: '',
      lookbackDays: 1,
      reconcileDays: 30,
    }),
    '2026-09-06',
  );
  assert.equal(
    _internals.startDayForDataset({
      values: [['2026-09-15']],
      cutoffDay: '2026-10-06',
      forcedDay: '2026-09-15',
      fallbackDay: '',
      lookbackDays: 1,
      reconcileDays: 30,
    }),
    '2026-09-15',
  );
});

test('mensagens publicas de cards nao carregam IDs internos', () => {
  assert.equal(_internals.assertNoSensitiveCardIdsInPublicMessages(), true);
});

test('cards usam end_date exclusivo no dia seguinte', () => {
  assert.deepEqual(
    _internals.cardFilterRange('2026-09-15'),
    { start_date: '2026-09-15', end_date: '2026-09-16' },
  );
});

test('validacao de 30 dias cobre exatamente os 30 dias completos ate o corte', () => {
  assert.equal(_internals.validationStartDay('2026-10-06', 30), '2026-09-07');

  const sheet = _internals.countRowsByDay(
    [['2026-09-07'], ['2026-09-07'], ['2026-10-06'], ['2026-09-06']],
    '2026-09-07',
    '2026-10-06',
  );
  assert.equal(sheet.get('2026-09-07'), 2);
  assert.equal(sheet.get('2026-10-06'), 1);

  const source = new Map(sheet);
  assert.deepEqual(
    _internals.compareDayCounts('teste', source, sheet, '2026-09-07', '2026-10-06'),
    { sourceTotal: 3, sheetTotal: 3, days: 30, mismatches: 0 },
  );

  const divergent = new Map(sheet);
  divergent.set('2026-09-07', 1);
  assert.throws(
    () => _internals.compareDayCounts('teste', source, divergent, '2026-09-07', '2026-10-06'),
    /Validacao de teste falhou/,
  );
});

test('mantem os contratos de largura das tres abas', () => {
  const service = _internals.serviceToRow({
    id: 'service-1',
    created_at: '2026-10-06T12:30:00Z',
    person: {},
    session: {},
    service_times: {},
  });
  const attendant = _internals.attendantToRow({ user: { id: 'user-1' } }, '2026-09-15');
  const card = _internals.cardToRow({
    id: 'card-1',
    created_at: '2026-09-15T12:00:00Z',
    custom_fields: [{ custom_field: 'field-1', value: 'ok' }],
  }, ['field-1']);

  assert.equal(service.length, 28);
  assert.equal(attendant.length, 19);
  assert.equal(card.length, 51);
  assert.equal(card[37], 'ok');
});

test('nao apaga um dia existente quando a API volta vazia', () => {
  assert.throws(
    () => _internals.assertReplacementIsSafe([['15/09/2026']], 0, '2026-09-15', [], 'cards'),
    /substituicao cancelada/,
  );
});

test('duracoes acima de 99 horas nao sao enviadas como TIME invalido', () => {
  const service = _internals.serviceToRow({
    id: 'service-long',
    created_at: '2026-09-15T12:00:00Z',
    person: {},
    session: {},
    service_times: { bot_total_time: 100 * 3600 },
  });
  assert.equal(String(service[4]), '100:00:00');
});

test('compara conjuntos de IDs sem depender da ordem', () => {
  const left = new Map([['1', {}], ['2', {}]]);
  const right = new Map([['2', {}], ['1', {}]]);
  assert.equal(_internals.sameIdSet(left, right), true);
});
