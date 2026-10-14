
const axios = require('axios');
const config = require('../config');

const BASE = config.mpesa.env === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const auth = Buffer.from(
    config.mpesa.consumerKey + ':' + config.mpesa.consumerSecret
  ).toString('base64');

  const { data } = await axios.get(
    BASE + '/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: 'Basic ' + auth }, timeout: 10000 }
  );

  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (Number(data.expires_in || 3599) - 60) * 1000;
  return cachedToken;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  );
}


function normalizePhone(phone) {
  let v = String(phone).replace(/[^\d]/g, '');
  if (v.startsWith('0')) v = '254' + v.slice(1);
  return v;
}

async function stkPush({ phone, amount, accountReference, description }) {
  const token = await getAccessToken();
  const ts = timestamp();
  const password = Buffer.from(
    config.mpesa.shortcode + config.mpesa.passkey + ts
  ).toString('base64');

  const { data } = await axios.post(
    BASE + '/mpesa/stkpush/v1/processrequest',
    {
      BusinessShortCode: config.mpesa.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: normalizePhone(phone),
      PartyB: config.mpesa.shortcode,
      PhoneNumber: normalizePhone(phone),
      CallBackURL: config.mpesa.callbackUrl,
      AccountReference: accountReference || 'MARNET',
      TransactionDesc: description || 'MarNet WiFi',
    },
    { headers: { Authorization: 'Bearer ' + token }, timeout: 15000 }
  );

  return data; 
}


async function stkQuery(checkoutRequestId) {
  const token = await getAccessToken();
  const ts = timestamp();
  const password = Buffer.from(
    config.mpesa.shortcode + config.mpesa.passkey + ts
  ).toString('base64');

  try {
    const { data } = await axios.post(
      BASE + '/mpesa/stkpushquery/v1/query',
      {
        BusinessShortCode: config.mpesa.shortcode,
        Password: password,
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      },
      { headers: { Authorization: 'Bearer ' + token }, timeout: 15000 }
    );
    if (data.ResultCode === undefined || data.ResultCode === null || data.ResultCode === '') {
      return { done: false };
    }
    return { done: true, resultCode: Number(data.ResultCode), desc: data.ResultDesc };
  } catch (err) {
    
    const d = err.response && err.response.data;
    if (d && d.errorCode === '500.001.1001') return { done: false };
    throw err;
  }
}


async function registerC2BUrl() {
  if (!config.mpesa.c2bConfirmationUrl || !config.mpesa.c2bValidationUrl) {
    throw new Error('MPESA_C2B_CONFIRMATION_URL / MPESA_C2B_VALIDATION_URL are not set');
  }
  const token = await getAccessToken();
  const { data } = await axios.post(
    BASE + '/mpesa/c2b/v1/registerurl',
    {
      ShortCode: config.mpesa.shortcode,
      ResponseType: 'Completed',
      ConfirmationURL: config.mpesa.c2bConfirmationUrl,
      ValidationURL: config.mpesa.c2bValidationUrl,
    },
    { headers: { Authorization: 'Bearer ' + token }, timeout: 15000 }
  );
  return data;
}

module.exports = { stkPush, stkQuery, normalizePhone, registerC2BUrl };
