import express from 'express';
import { isMain } from '../lib/isMain.js';

/**
 * A stand-in for the TallyPrime Bridge, for local development only.
 *
 * It implements docs/bridge-contract.md and nothing else: it does not talk to
 * Tally, it just answers the way Tally does. That is enough to exercise the
 * whole pipeline -- including the failure modes that matter, which are the ones
 * you cannot reproduce against a real Tally on demand:
 *
 *   MOCK_BRIDGE_MODE=ok       vouchers are accepted (default)
 *   MOCK_BRIDGE_MODE=down     connection refused behaviour: 503, retryable
 *   MOCK_BRIDGE_MODE=noledger permanent LINEERROR, goes to a human
 *
 * Never point a tenant at this in production. It reports success without
 * writing a single voucher anywhere.
 */

interface StoredVoucher {
  remoteId: string;
  reference: string;
  party: string;
  amount: string;
  xml: string;
  cancelled: boolean;
  voucherId: number;
}

const vouchers = new Map<string, StoredVoucher>();
let nextVoucherId = 4200;

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? (m[1] ?? '').trim() : null;
};

export function createMockBridge() {
  const app = express();
  app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '1mb' }));
  app.use(express.json());

  const mode = () => process.env.MOCK_BRIDGE_MODE ?? 'ok';

  app.get('/health', (_req, res) => {
    if (mode() === 'down') return res.status(503).json({ ok: false, reason: 'tally not running' });
    res.json({ ok: true, company: 'Demo Traders Ltd', tallyVersion: 'MockTally 0.1', mode: mode() });
  });

  app.get('/outstanding', (req, res) => {
    if (mode() === 'down') return res.status(503).json({ error: 'tally not running' });

    // Mirrors the seed data so the matcher has something to work against.
    res.json({
      bills: [
        { voucherNumber: 'INV-1001', partyLedger: 'Acme Hardware Ltd', partyMsisdn: '0712345678', invoiceDate: '2026-08-20', amount: '15000.00', amountSettled: '0.00' },
        { voucherNumber: 'INV-1002', partyLedger: 'Bluewave Salon', partyMsisdn: '0722000111', invoiceDate: '2026-08-25', amount: '3500.00', amountSettled: '0.00' },
        { voucherNumber: 'INV-1003', partyLedger: 'Kimani Wholesalers', partyMsisdn: null, invoiceDate: '2026-09-01', amount: '7250.00', amountSettled: '0.00' },
        { voucherNumber: 'INV-1004', partyLedger: 'Riverside Cafe', partyMsisdn: null, invoiceDate: '2026-09-02', amount: '4800.00', amountSettled: '0.00' },
        { voucherNumber: 'INV-1005', partyLedger: 'Tuskys Corner Shop', partyMsisdn: null, invoiceDate: '2026-09-03', amount: '4800.00', amountSettled: '0.00' },
      ],
      company: String(req.query.company ?? ''),
    });
  });

  app.post('/import', (req, res) => {
    if (mode() === 'down') {
      return res.status(503).send('<RESPONSE><ERRORS>0</ERRORS><LINEERROR>Tally is not running</LINEERROR></RESPONSE>');
    }

    const xml = typeof req.body === 'string' ? req.body : String(req.body);
    const remoteId = tag(xml, 'REMOTEID');

    if (mode() === 'noledger') {
      return res.send(
        '<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS>' +
          '<LINEERROR>Ledger "Unknown Customer" does not exist</LINEERROR></RESPONSE>',
      );
    }

    if (!remoteId) {
      return res.send('<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Missing REMOTEID</LINEERROR></RESPONSE>');
    }

    const cancelling = /ACTION="Cancel"/i.test(xml);
    const existing = vouchers.get(remoteId);

    if (cancelling) {
      if (!existing) {
        return res.send('<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Voucher not found</LINEERROR></RESPONSE>');
      }
      existing.cancelled = true;
      return res.send(`<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><ERRORS>0</ERRORS><LASTVCHID>${existing.voucherId}</LASTVCHID></RESPONSE>`);
    }

    // The REMOTEID contract: a repeat of the same receipt alters, never duplicates.
    if (existing) {
      existing.xml = xml;
      existing.cancelled = false;
      return res.send(`<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><ERRORS>0</ERRORS><LASTVCHID>${existing.voucherId}</LASTVCHID></RESPONSE>`);
    }

    const voucherId = nextVoucherId++;
    vouchers.set(remoteId, {
      remoteId,
      reference: tag(xml, 'REFERENCE') ?? '',
      party: tag(xml, 'PARTYLEDGERNAME') ?? '',
      amount: tag(xml, 'AMOUNT') ?? '',
      xml,
      cancelled: false,
      voucherId,
    });

    res.send(`<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>${voucherId}</LASTVCHID></RESPONSE>`);
  });

  /** Not part of the contract: lets the dev loop assert what "Tally" received. */
  app.get('/_vouchers', (_req, res) => {
    res.json({
      count: vouchers.size,
      vouchers: [...vouchers.values()].map(({ xml, ...rest }) => rest),
    });
  });

  return app;
}

if (isMain(import.meta.url)) {
  const port = Number(process.env.MOCK_BRIDGE_PORT ?? 5050);
  createMockBridge().listen(port, () => {
    console.log(`mock Tally Bridge on http://127.0.0.1:${port} (mode=${process.env.MOCK_BRIDGE_MODE ?? 'ok'})`);
  });
}
