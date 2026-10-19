# apps/broker (next slice)

The Operator logic already exists in `packages/broker` and runs inside the API process for now: approved rules over real payments → rail calls, exceptions, passkey-gated refunds. This app is where it moves when the broker is deployed on its own.

Runs outside every sandbox (Railway: `stripe projects add railway/hosting`). The only component that holds real keys.
- Placeholder → real key swap on egress, per allowed host and action (keyless agents)
- Mera-signed spending mandates: checked before every payment
- Irreversible actions (refund, payout, new subscription) require an owner passkey assertion
- Executes `@reeve/rails` adapters (Stripe now; Xendit / Midtrans payouts with gateway approval)
- Holds `COMPOSIO_API_KEY`; sandboxes never see it
