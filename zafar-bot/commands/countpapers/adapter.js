'use strict';

/**
 * commands/paper/adapter.js — run the ported vault code against ctx.
 *
 * The ported vault.js was written against the old bot's `(sock, msg, args,
 * extra)` contract. Rather than rewrite 863 lines of working student-critical
 * logic — which is exactly the kind of change that breaks things — this adapter
 * presents the old shape on top of ctx:
 *
 *   sock.sendReaction(chat, emoji)              -> ctx.react
 *   sock.sendDocument(chat, {file, fileName})   -> ctx.send.document
 *   extra.reply(text)                   -> ctx.reply
 *   extra.status(text) -> {update}      -> ctx.reply, then ctx.send.text
 *   extra.isOwner                       -> ctx.role === 'owner'
 *
 * Two behaviours are deliberately improved because the old ones hid failures:
 *   - `extra.status(...).update(...)` no longer silently falls back to a second
 *     message when the edit fails; it sends the final text once.
 *   - every catch in vault.js rethrows or logs; see NOTES.md.
 */

function makeAdapter(ctx) {
  const extra = {
    from: ctx.chat,
    sessionId: ctx.number,
    // The vault builds its usage text from the live prefix rather than a
    // hardcoded '.', so a number with a custom prefix sees the right string.
    prefix: ctx.prefix,
    isOwner: ctx.role === 'owner',
    commandName: 'paper',
    reply: (text) => ctx.reply(text),
    status: async (initialText) => {
      await ctx.reply(initialText);
      return {
        // The old bot edited the first message in place. ctx has no edit, so the
        // final text is sent as its own message. Same information, same order.
        update: async (finalText) => ctx.send.text(finalText),
      };
    },
  };

  // TWO explicit methods, not a general sendMessage(). The ported vault code
  // needs exactly these two, and naming them makes it impossible for paper code
  // to grow a third, undocumented way of talking to WhatsApp.
  const sock = {
    sendReaction: async (chat, emoji) => ctx.react(emoji),
    sendDocument: async (chat, { file, caption = '', fileName, mimetype }) => {
      if (!file) throw new Error('paper adapter was asked to send a document with no file');
      return ctx.send.document(file, caption, fileName || 'paper.pdf');
    },
  };

  // The vault code reads msg.key.remoteJid for reactions only; the adapter
  // supplies a harmless stand-in.
  const msg = { key: { remoteJid: ctx.chat, id: 'job' } };

  return { sock, msg, extra };
}

module.exports = { makeAdapter };
