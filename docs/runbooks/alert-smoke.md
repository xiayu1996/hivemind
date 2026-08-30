# Out-of-band alert smoke

Store deployment credentials in `~/.hivemind/secrets.env`. Configure at least one channel:

- `FEISHU_WEBHOOK_URL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TO`

`SMTP_TO` accepts a comma-separated recipient list. Then run:

```sh
npx tsx scripts/smoke-alert.ts
```

The script sends one P0 smoke alert and reports only the channel name. It never prints webhook URLs, SMTP credentials, or recipient addresses.
