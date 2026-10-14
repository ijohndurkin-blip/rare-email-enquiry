// Sends email from the business's own enquiries mailbox over SMTP.
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');
const { decrypt } = require('./security');

let transportFactory = (opts) => nodemailer.createTransport(opts);

function canSend(business) {
  const ib = business.settings.inbox;
  return Boolean(ib.smtpHost && (ib.user || ib.email) && ib.password);
}

function fromAddress(business) {
  const ib = business.settings.inbox;
  return { name: business.name, address: ib.email || ib.user };
}

/**
 * @param {object} business
 * @param {{to:string, subject:string, text:string, inReplyTo?:string, references?:string[]}} mail
 * @returns {Promise<{messageId:string}>}
 */
async function send(business, mail) {
  if (!canSend(business)) throw new Error('This business\'s mailbox isn\'t connected for sending yet.');
  const ib = business.settings.inbox;
  const pass = decrypt(ib.password);
  const from = fromAddress(business);
  const messageId = `<${crypto.randomUUID()}@${from.address.split('@')[1] || 'enquiries.local'}>`;
  const message = {
    from, to: mail.to, subject: mail.subject, text: mail.text, messageId,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.references?.length ? mail.references : [mail.inReplyTo] } : {}),
  };
  const transport = transportFactory({
    host: ib.smtpHost, port: Number(ib.smtpPort) || 465, secure: ib.smtpSecure !== false,
    auth: { user: ib.user || ib.email, pass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
  try {
    await transport.sendMail(message);
  } finally {
    transport.close?.();
  }
  if (ib.saveToSent && ib.sentFolder && ib.host) {
    // Some hosts don't keep a copy of mail sent over SMTP; file one so the mailbox stays complete.
    copyToSent(business, message).catch((err) => console.warn(`[mail] couldn't copy to Sent for ${business.slug}: ${err.message}`));
  }
  return { messageId };
}

async function copyToSent(business, message) {
  const ib = business.settings.inbox;
  const raw = await new MailComposer(message).compile().build();
  const imap = new ImapFlow({
    host: ib.host, port: Number(ib.port) || 993, secure: ib.secure !== false,
    auth: { user: ib.user || ib.email, pass: decrypt(ib.password) }, logger: false,
  });
  imap.on('error', () => {});
  await imap.connect();
  try {
    await imap.append(ib.sentFolder, raw, ['\\Seen']);
  } finally {
    await imap.logout().catch(() => {});
  }
}

module.exports = { send, canSend, _setTransportFactory: (f) => { transportFactory = f; } };
