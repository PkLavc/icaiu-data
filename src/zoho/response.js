function extractZohoRecords(response, dataset) {
  if (Number(response?.status) !== 200) {
    throw new Error(`Zoho retornou status inesperado para ${dataset}`);
  }
  const body = response.data;
  if (
    body &&
    typeof body === "object" &&
    Number(body.code) === 3100
  ) {
    return [];
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Object.prototype.hasOwnProperty.call(body, "data") ||
    !Array.isArray(body.data)
  ) {
    const error = new Error(`Zoho retornou lista invalida para ${dataset}`);
    error.code = "ZOHO_INVALID_RECORD_LIST";
    throw error;
  }
  return body.data;
}

module.exports = { extractZohoRecords };
