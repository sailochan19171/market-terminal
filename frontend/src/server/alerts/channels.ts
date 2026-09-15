// Alert delivery channels: Telegram (Bot API), email (SMTP) and Windows desktop toasts.
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";
import { config } from "../config";
import { logger } from "../log";

const log = logger("alerts");

export interface Channel {
  name: string;
  available(): boolean;
  send(subject: string, body: string): Promise<void>;
}

const TELEGRAM_LIMIT = 4096;

/** Split on line boundaries so Markdown stays intact where possible. */
function* split(text: string, limit: number) {
  if (text.length <= limit) {
    yield text;
    return;
  }
  let buf = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (buf.length + line.length > limit) {
      if (buf) yield buf;
      buf = line.slice(0, limit);
    } else buf += line;
  }
  if (buf) yield buf;
}

export class TelegramChannel implements Channel {
  name = "telegram";
  constructor(private token = config.TELEGRAM_BOT_TOKEN, private chatId = config.TELEGRAM_CHAT_ID) {}
  available() {
    return Boolean(this.token && this.chatId);
  }
  async send(subject: string, body: string) {
    const text = subject ? `*${subject}*\n\n${body}` : body;
    for (const chunk of split(text, TELEGRAM_LIMIT)) {
      const resp = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: chunk, parse_mode: "Markdown", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) throw new Error(`telegram HTTP ${resp.status}`);
    }
  }
}

export class EmailChannel implements Channel {
  name = "email";
  private sender = config.ALERT_EMAIL_FROM || config.SMTP_USER;
  available() {
    return Boolean(config.SMTP_HOST && this.sender && config.ALERT_EMAIL_TO.length);
  }
  async send(subject: string, body: string) {
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      // STARTTLS when offered; a local relay without it still works.
      requireTLS: false,
      auth: config.SMTP_USER && config.SMTP_PASSWORD ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      connectionTimeout: 30_000,
    });
    await transport.sendMail({ from: this.sender, to: config.ALERT_EMAIL_TO.join(", "), subject: subject || "BSE alert", text: body });
  }
}

const PS_TOAST = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:BSE_TOAST_TITLE)) > $null
$n.Item(1).AppendChild($t.CreateTextNode($env:BSE_TOAST_BODY)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('BSE Pipeline').Show($toast)
`;

export class DesktopChannel implements Channel {
  name = "desktop";
  available() {
    return true; // degrades to stdout off Windows
  }
  async send(subject: string, body: string) {
    if (process.platform !== "win32") {
      console.log(`[BSE ALERT] ${subject}\n${body}`);
      return;
    }
    const env = {
      ...process.env,
      BSE_TOAST_TITLE: (subject || "BSE alert").slice(0, 120),
      // Toasts truncate hard; keep the first line only.
      BSE_TOAST_BODY: body.trim() ? body.trim().split(/\r?\n/)[0].slice(0, 250) : "",
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_TOAST], { env, windowsHide: true, timeout: 30_000 });
        p.on("error", reject);
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`powershell exited ${code}`))));
      });
    } catch (e) {
      log.warn(`toast failed (${(e as Error).message}); printing instead`);
      console.log(`[BSE ALERT] ${subject}\n${body}`);
    }
  }
}

const REGISTRY: Record<string, () => Channel> = {
  telegram: () => new TelegramChannel(),
  email: () => new EmailChannel(),
  desktop: () => new DesktopChannel(),
};

/** Instantiate the configured channels. Unconfigured ones are skipped. */
export function buildChannels(names: string[] = config.ALERT_CHANNELS): Channel[] {
  const out: Channel[] = [];
  for (const name of names) {
    const make = REGISTRY[name];
    if (!make) {
      log.warn(`unknown alert channel '${name}' (known: ${Object.keys(REGISTRY).join(", ")})`);
      continue;
    }
    const ch = make();
    if (ch.available()) out.push(ch);
    else log.warn(`alert channel '${name}' is not configured; skipping`);
  }
  return out;
}

/** Deliver to every channel; a failing channel never blocks the others. */
export async function sendAll(channels: Channel[], subject: string, body: string): Promise<string[]> {
  const delivered: string[] = [];
  for (const ch of channels) {
    try {
      await ch.send(subject, body);
      delivered.push(ch.name);
    } catch (e) {
      log.error(`alert via ${ch.name} failed: ${(e as Error).message}`);
    }
  }
  return delivered;
}
