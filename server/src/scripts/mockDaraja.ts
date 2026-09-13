import { randomUUID } from 'node:crypto';
import express from 'express';
import { request } from 'undici';
import { isMain } from '../lib/isMain.js';

/**
 * A stand-in for Safaricom's Daraja API, for local development only.
 *
 * The sandbox is unreliable for exactly the flows that matter, and it cannot be
 * made to produce a declined PIN or a silent handset on demand. This can:
 *
 *   MOCK_DARAJA_MODE=paid      customer pays (default)
 *   MOCK_DARAJA_MODE=cancelled customer cancels the prompt   (1032)
 *   MOCK_DARAJA_MODE=timeout   handset never answers         (1037)
 *   MOCK_DARAJA_MODE=nocallback accepted, but the callback never arrives --
 *                              the case the status-query reconciler exists for
 *
 * It answers the STK request immediately and then fires the callback a moment
 * later, the way Safaricom does. Never point a tenant at this.
 */

interface Push {
  checkoutRequestId: string;
  merchantRequestId: string;
  shortcode: string;
  msisdn: string;
  amount: number;
  callbackUrl: string;
  settled: boolean;
  resultCode: string;
}

const pushes = new Map<string, Push>();
let receiptCounter = 0;

const mode = () => process.env.MOCK_DARAJA_MODE ?? 'paid';

/** Receipt numbers look like SI74HJ8K01: ten upper-case alphanumerics. */
function nextReceipt(): string {
  receiptCounter++;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = 'M';
  for (let i = 0; i < 7; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${s}${String(receiptCounter).padStart(2, '0')}`;
}

function darajaTimestamp(): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}${g('month')}${g('day')}${g('hour')}${g('minute')}${g('second')}`;
}

async function fireCallback(push: Push): Promise<void> {
  const paid = push.resultCode === '0';

  const body = {
    Body: {
      stkCallback: {
        MerchantRequestID: push.merchantRequestId,
        CheckoutRequestID: push.checkoutRequestId,
        ResultCode: Number(push.resultCode),
        ResultDesc: paid
          ? 'The service request is processed successfully.'
          : 'Request cancelled by user',
        ...(paid
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: push.amount },
                  { Name: 'MpesaReceiptNumber', Value: nextReceipt() },
                  { Name: 'TransactionDate', Value: Number(darajaTimestamp()) },
                  { Name: 'PhoneNumber', Value: Number(push.msisdn) },
                ],
              },
            }
          : {}),
      },
    },
  };

  try {
    await request(push.callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    push.settled = true;
    console.log(`[mock-daraja] callback delivered for ${push.checkoutRequestId} (code ${push.resultCode})`);
  } catch (err) {
    console.error('[mock-daraja] callback delivery failed:', (err as Error).message);
  }
}

export function createMockDaraja() {
  const app = express();
  app.use(express.json());

  app.get('/oauth/v1/generate', (_req, res) => {
    res.json({ access_token: `mock-${randomUUID()}`, expires_in: '3599' });
  });

  app.post('/mpesa/stkpush/v1/processrequest', (req, res) => {
    const b = req.body as Record<string, unknown>;

    // Daraja is strict about these three; getting them wrong is the usual cause
    // of a correct-looking request failing, so the mock checks them too.
    for (const field of ['BusinessShortCode', 'Password', 'Timestamp', 'Amount', 'PhoneNumber', 'CallBackURL']) {
      if (!b[field]) {
        return res.status(400).json({ errorCode: '400.002.02', errorMessage: `Bad Request - Invalid ${field}` });
      }
    }
    if (!/^\d{14}$/.test(String(b.Timestamp))) {
      return res.status(400).json({ errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid Timestamp' });
    }
    if (!Number.isInteger(b.Amount)) {
      return res.status(400).json({ errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid Amount' });
    }

    const push: Push = {
      checkoutRequestId: `ws_CO_${Date.now()}${Math.floor(Math.random() * 1000)}`,
      merchantRequestId: `${Math.floor(Math.random() * 90000) + 10000}-${Math.floor(Math.random() * 9000000)}-1`,
      shortcode: String(b.BusinessShortCode),
      msisdn: String(b.PhoneNumber),
      amount: Number(b.Amount),
      callbackUrl: String(b.CallBackURL),
      settled: false,
      // 'nocallback' is a PAID push whose callback never arrives -- the exact
      // case reconcileStalePushes() exists for. Treating it as cancelled would
      // test nothing.
      resultCode:
        mode() === 'paid' || mode() === 'nocallback' ? '0' : mode() === 'timeout' ? '1037' : '1032',
    };
    pushes.set(push.checkoutRequestId, push);

    res.json({
      MerchantRequestID: push.merchantRequestId,
      CheckoutRequestID: push.checkoutRequestId,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
    });

    // Safaricom takes a few seconds while the customer looks at their phone.
    if (mode() !== 'nocallback') {
      setTimeout(() => void fireCallback(push), Number(process.env.MOCK_DARAJA_DELAY_MS ?? 1500));
    }
  });

  app.post('/mpesa/stkpushquery/v1/query', (req, res) => {
    const id = String((req.body as Record<string, unknown>).CheckoutRequestID ?? '');
    const push = pushes.get(id);
    if (!push) {
      return res.json({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
    }
    res.json({
      ResponseCode: '0',
      ResponseDescription: 'The service request has been accepted successfully',
      MerchantRequestID: push.merchantRequestId,
      CheckoutRequestID: push.checkoutRequestId,
      ResultCode: push.resultCode,
      ResultDesc: push.resultCode === '0' ? 'The service request is processed successfully.' : 'Request cancelled by user',
    });
  });

  app.post('/mpesa/c2b/v1/registerurl', (_req, res) => {
    res.json({ ResponseDescription: 'Success', ResponseCode: '0' });
  });

  /** Not part of Daraja: lets the dev loop see what was requested. */
  app.get('/_pushes', (_req, res) => {
    res.json({ mode: mode(), count: pushes.size, pushes: [...pushes.values()] });
  });

  return app;
}

if (isMain(import.meta.url)) {
  const port = Number(process.env.MOCK_DARAJA_PORT ?? 5060);
  createMockDaraja().listen(port, () => {
    console.log(`mock Daraja on http://127.0.0.1:${port} (mode=${mode()})`);
    console.log('point DARAJA_BASE_URL at it');
  });
}
