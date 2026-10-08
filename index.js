'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  randomInt,
  randomUUID,
  randomBytes,
  createHash,
} = require('node:crypto');
const { gzipSync } = require('node:zlib');

const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType: C,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require('discord.js');

class UserError extends Error {}

const ID = /^\d{17,20}$/;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable manquante : ${name}`);
  return value;
}

function number(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Variable invalide : ${name}`);
  }

  return value;
}

const token = required('DISCORD_TOKEN');
const guildId = required('DISCORD_GUILD_ID');

const allowed = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
);

const defaultPublication =
  process.env.RESULTS_CHANNEL_ID?.trim() || '';

if (
  !ID.test(guildId) ||
  [...allowed].some(id => !ID.test(id)) ||
  (defaultPublication && !ID.test(defaultPublication))
) {
  throw new Error('Un identifiant Discord est invalide.');
}

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const maxScan = number('MAX_SCAN_MESSAGES', 50000, 100, 250000);
const maxSaved = number('MAX_SAVED_DRAWS', 100, 10, 1000);

const disclaimer =
  'Les fibettes sont des crédits virtuels non retirables. ' +
  'Réservé aux personnes majeures (18+). ' +
  'Jouer comporte des risques : endettement, isolement, dépendance. ' +
  'Pour être aidé, appelez le 09 74 75 13 13 (appel non surtaxé).';

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const dataFile = path.join(dataDir, 'tas.json');

let database = {
  version: 1,
  guildId,
  draws: [],
};

if (fs.existsSync(dataFile)) {
  database = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  if (
    database.version !== 1 ||
    database.guildId !== guildId ||
    !Array.isArray(database.draws)
  ) {
    throw new Error(
      'Le volume contient des tirages incompatibles ou liés à un autre serveur.'
    );
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    timeout: 15000,
    retries: 0,
  },
});

const scanLocks = new Set();
const drawLocks = new Set();
const jobs = new Set();

let ready = false;
let stopping = false;

function save() {
  fs.writeFileSync(
    `${dataFile}.tmp`,
    JSON.stringify(database),
    { mode: 0o600 }
  );

  fs.renameSync(`${dataFile}.tmp`, dataFile);
}

function logError(where, error) {
  console.error(
    `${where} : ${error?.code || error?.name || 'Erreur'}`
  );
}

function authorized(interaction) {
  return (
    interaction.guildId === guildId &&
    (
      allowed.size
        ? allowed.has(interaction.user.id)
        : interaction.memberPermissions?.has(P.ManageGuild)
    )
  );
}

function mustBeAuthorized(interaction) {
  if (!authorized(interaction)) {
    throw new UserError(
      'Commande réservée à l’équipe autorisée.'
    );
  }

  if (!ready || stopping) {
    throw new UserError(
      'Le bot démarre ou s’arrête. Réessaie dans quelques instants.'
    );
  }
}

// Toutes les dates saisies sont interprétées en heure de Paris.
const parisParts = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parisKey(timestamp) {
  const parts = Object.fromEntries(
    parisParts
      .formatToParts(new Date(timestamp))
      .map(p => [p.type, p.value])
  );

  return (
    `${parts.year}-${parts.month}-${parts.day} ` +
    `${parts.hour}:${parts.minute}`
  );
}

function parseParis(text) {
  const match = text.trim().match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?:\s+([+-]\d{2}:\d{2}))?$/
  );

  if (!match) {
    throw new UserError(
      'Date attendue : JJ/MM/AAAA HH:mm, par exemple 07/10/2026 18:00.'
    );
  }

  const [, dd, mm, yyyy, hh, minutes, explicitOffset] = match;

  const [d, m, y, h, min] =
    [dd, mm, yyyy, hh, minutes].map(Number);

  if (
    y < 2015 ||
    y > 2100 ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31 ||
    h > 23 ||
    min > 59
  ) {
    throw new UserError('Date ou heure invalide.');
  }

  const utc = Date.UTC(y, m - 1, d, h, min);
  const check = new Date(utc);

  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    throw new UserError('Cette date n’existe pas.');
  }

  const expected = `${yyyy}-${mm}-${dd} ${hh}:${minutes}`;
  let matches = [];

  for (let offset = -14; offset <= 14; offset++) {
    const timestamp = utc - offset * 3600000;

    if (parisKey(timestamp) === expected) {
      matches.push(timestamp);
    }
  }

  if (explicitOffset) {
    const hours = Number(explicitOffset.slice(1, 3));
    const mins = Number(explicitOffset.slice(4, 6));

    if (hours > 14 || mins > 59) {
      throw new UserError('Décalage UTC invalide.');
    }

    const delta =
      (explicitOffset[0] === '+' ? 1 : -1) *
      (hours * 60 + mins) *
      60000;

    matches = matches.filter(
      timestamp => timestamp === utc - delta
    );
  }

  if (!matches.length) {
    throw new UserError(
      'Heure inexistante à Paris ou décalage UTC incorrect. Vérifie le changement d’heure.'
    );
  }

  if (matches.length > 1) {
    throw new UserError(
      'Heure ambiguë au passage à l’heure d’hiver. Ajoute +02:00 pour la première occurrence ou +01:00 pour la seconde.'
    );
  }

  return matches[0];
}

function link(channelId, messageId) {
  return (
    `https://discord.com/channels/${guildId}/${channelId}` +
    (messageId ? `/${messageId}` : '')
  );
}

function parseTarget(value) {
  const raw = value.trim().replace(/^<(.+)>$/, '$1');

  if (ID.test(raw)) {
    return { channelId: raw };
  }

  const mention = raw.match(/^#(\d{17,20})$/);

  if (mention) {
    return { channelId: mention[1] };
  }

  const match = raw.match(
    /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/(\d{17,20}))?\/?(?:\?[^#]*)?$/
  );

  if (!match || match[1] !== guildId) {
    throw new UserError(
      'Donne le lien du fil, du post de forum ou du message d’annonce de ce serveur.'
    );
  }

  return {
    channelId: match[2],
    messageId: match[3],
  };
}

async function resolveThread(guild, value) {
  const target = parseTarget(value);
  const channel = await guild.channels.fetch(target.channelId);

  if (channel && channel.guildId !== guildId) {
    throw new UserError(
      'Le fil doit appartenir au serveur configuré.'
    );
  }

  if (channel?.isThread()) {
    return channel;
  }

  if (!channel || !target.messageId) {
    throw new UserError(
      'Choisis un fil précis, pas le salon d’annonces ou le forum entier.'
    );
  }

  if (
    channel.type === C.GuildForum ||
    channel.type === C.GuildMedia
  ) {
    const thread = await guild.channels.fetch(target.messageId);

    if (
      thread?.isThread() &&
      thread.parentId === channel.id
    ) {
      return thread;
    }
  } else if (
    [C.GuildText, C.GuildAnnouncement].includes(channel.type)
  ) {
    const message =
      await channel.messages.fetch(target.messageId);

    if (message.hasThread) {
      const thread =
        message.thread ||
        await guild.channels.fetch(message.id);

      if (
        thread?.isThread() &&
        thread.parentId === channel.id
      ) {
        return thread;
      }
    }
  }

  throw new UserError(
    'Aucun fil associé trouvé. Copie directement le lien d’un message dans le fil souhaité.'
  );
}

async function requireReadAccess(thread) {
  const me =
    thread.guild.members.me ||
    await thread.guild.members.fetchMe();

  if (
    !thread.permissionsFor(me)?.has([
      P.ViewChannel,
      P.ReadMessageHistory,
    ])
  ) {
    throw new UserError(
      'Le bot doit pouvoir voir le fil et lire son historique. Pour un fil privé, ajoute-le au fil.'
    );
  }
}

function cutoffSnowflake(timestamp) {
  return (
    (BigInt(timestamp) - 1420070400000n) << 22n
  ).toString();
}

async function scan(thread, start, end, progress) {
  await requireReadAccess(thread);

  const participants = new Map();

  let before = cutoffSnowflake(end);
  let scanned = 0;
  let pages = 0;
  let counted = 0;
  let ignored = 0;

  const deadline = Date.now() + 10 * 60000;
  const seen = new Set();

  for (;;) {
    if (stopping) {
      throw new UserError(
        'Analyse interrompue par l’arrêt du bot. Aucun tirage partiel effectué.'
      );
    }

    if (Date.now() > deadline) {
      throw new UserError(
        'Analyse trop longue. Réduis la période ; aucun tirage partiel effectué.'
      );
    }

    const batch = await thread.messages.fetch({
      limit: 100,
      before,
      cache: false,
    });

    if (!batch.size) break;

    const rows = [...batch.values()];

    const oldestId = rows.reduce(
      (a, b) => BigInt(a.id) < BigInt(b.id) ? a : b
    ).id;

    if (BigInt(oldestId) >= BigInt(before)) {
      throw new UserError(
        'Historique incohérent. Aucun tirage effectué.'
      );
    }

    pages++;
    scanned += rows.length;

    if (scanned > maxScan) {
      throw new UserError(
        `Limite de ${maxScan} messages analysés atteinte. Réduis la période ; aucun tirage partiel effectué.`
      );
    }

    for (const message of rows) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);

      const timestamp = message.createdTimestamp;

      if (timestamp < start || timestamp >= end) continue;

      // La fiche initiale du post n'est pas une participation.
      if (
        message.id === thread.id ||
        ![0, 19].includes(message.type) ||
        !message.author ||
        message.author.bot ||
        message.webhookId
      ) {
        ignored++;
        continue;
      }

      let entry = participants.get(message.author.id);

      if (!entry) {
        entry = {
          id: message.author.id,
          username: message.author.username,
          count: 0,
          messageIds: [],
        };

        participants.set(entry.id, entry);
      }

      entry.count++;
      entry.messageIds.push(message.id);
      counted++;
    }

    await progress({
      scanned,
      pages,
      counted,
      users: participants.size,
    });

    before = oldestId;

    if (
      rows.length < 100 ||
      rows.every(message => message.createdTimestamp < start)
    ) {
      break;
    }
  }

  return {
    entries: [...participants.values()].sort(
      (a, b) => a.id.localeCompare(b.id)
    ),
    scanned,
    pages,
    counted,
    ignored,
  };
}

// Une seule chance par personne et aucun gagnant en double.
function sample(entries, count) {
  if (count > entries.length) {
    throw new UserError(
      'Pas assez de participants éligibles.'
    );
  }

  const pool = [...entries];

  for (let i = 0; i < count; i++) {
    const selected = randomInt(i, pool.length);

    [pool[i], pool[selected]] =
      [pool[selected], pool[i]];
  }

  return pool.slice(0, count).map(
    ({ id, username, count: messages }) => ({
      id,
      username,
      messages,
    })
  );
}

function fingerprint(threadId, start, end, maximum, winnerCount) {
  return createHash('sha256')
    .update(JSON.stringify([
      guildId,
      threadId,
      start,
      end,
      maximum,
      winnerCount,
    ]))
    .digest('hex');
}

function recordHash(record) {
  return createHash('sha256')
    .update(JSON.stringify({
      threadId: record.threadId,
      start: record.start,
      end: record.end,
      maximum: record.maximum,
      entries: record.entries,
      winners: record.winners,
    }))
    .digest('hex');
}

function getDraw(id) {
  const draw = database.draws.find(d => d.id === id);

  if (!draw) {
    throw new UserError(
      'Tirage introuvable. Vérifie son identifiant ou sa présence parmi les tirages conservés.'
    );
  }

  return draw;
}

function csvCell(value) {
  let text = String(value ?? '');

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function exportsFor(draw) {
  const winners = new Set(draw.winners.map(w => w.id));

  const rows = [[
    'ID_Discord',
    'Pseudo',
    'Messages',
    'Eligible',
    'Gagnant',
    'IDs_messages',
  ]];

  for (const p of draw.entries) {
    rows.push([
      p.id,
      p.username,
      p.count,
      p.count <= draw.maximum ? 'oui' : 'non',
      winners.has(p.id) ? 'oui' : 'non',
      p.messageIds.join(' | '),
    ]);
  }

  const csv =
    '\ufeff' +
    rows.map(row => row.map(csvCell).join(';')).join('\r\n');

  const attachment = (text, name) => {
    const buffer = Buffer.from(text, 'utf8');

    return buffer.length > 8 * 1024 * 1024
      ? new AttachmentBuilder(gzipSync(buffer), {
          name: `${name}.gz`,
        })
      : new AttachmentBuilder(buffer, { name });
  };

  return [
    attachment(csv, `participants-${draw.id}.csv`),

    attachment(
      JSON.stringify(draw, null, 2),
      `audit-${draw.id}.json`
    ),

    new AttachmentBuilder(
      Buffer.from(
        draw.winners.map(w => `<@${w.id}>`).join('\n') ||
        'Aucun gagnant : tirage non effectué.',
        'utf8'
      ),
      { name: `gagnants-${draw.id}.txt` }
    ),
  ];
}

function chunks(lines, max = 950) {
  const output = [];
  let current = '';

  for (const line of lines) {
    if (
      current &&
      current.length + line.length + 1 > max
    ) {
      output.push(current);
      current = '';
    }

    current += (current ? '\n' : '') + line;
  }

  if (current) output.push(current);

  return output;
}

function preview(draw) {
  const status = {
    drawn: 'Tirage effectué, en attente de publication',
    insufficient: 'Pas assez de participants : aucun tirage effectué',
    published: 'Gagnants publiés',
    cancelled: 'Tirage annulé',
    publishing: 'Publication en cours',
    publication_unknown: 'Publication à vérifier avant toute autre action',
  }[draw.status] || draw.status;

  const embed = new EmbedBuilder()
    .setColor(draw.status === 'insufficient' ? 0xd99800 : 0x133cc4)
    .setTitle('Tirage au sort Betclic')
    .setURL(link(draw.threadId))
    .setDescription(
      `${status}\n` +
      `Début **inclus** : ${draw.startText}\n` +
      `Clôture **exclue** : ${draw.endText}\n` +
      'Heures de Paris.'
    )
    .addFields(
      {
        name: 'Participants',
        value:
          `${draw.entries.length} personnes\n` +
          `${draw.eligible} éligibles\n` +
          `${draw.excluded} exclues`,
        inline: true,
      },
      {
        name: 'Règle',
        value:
          `1 à ${draw.maximum} messages : éligible\n` +
          `${draw.maximum + 1} ou plus : exclu\n` +
          'Une chance par personne',
        inline: true,
      },
      {
        name: 'Messages comptés',
        value:
          `${draw.counted}\n` +
          `${draw.scanned} messages parcourus`,
        inline: true,
      },
      {
        name: 'Gagnants demandés',
        value: String(draw.requested),
        inline: true,
      },
      {
        name: 'Publication prévue',
        value: `<#${draw.publicationChannelId}>`,
        inline: true,
      },
      {
        name: 'Lot par gagnant',
        value: draw.prize || 'Selon l’annonce initiale',
        inline: true,
      }
    )
    .setFooter({ text: `TAS ${draw.id}` });

  if (draw.winners.length) {
    const groups = chunks(
      draw.winners.map(
        (w, n) =>
          `${n + 1}. <@${w.id}> ` +
          `(${w.messages} message${w.messages > 1 ? 's' : ''})`
      )
    );

    for (const [i, text] of groups.entries()) {
      embed.addFields({
        name: i ? 'Gagnants (suite)' : 'Gagnants',
        value: text,
      });
    }
  }

  if (draw.publicationUrl) {
    embed.addFields({
      name: 'Publication',
      value: draw.publicationUrl,
    });
  }

  const row = new ActionRowBuilder();

  if (draw.status === 'drawn') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`tas:publish:${draw.id}`)
        .setLabel('Publier les gagnants')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`tas:cancel:${draw.id}`)
        .setLabel('Annuler ce tirage')
        .setStyle(ButtonStyle.Danger)
    );
  } else if (
    draw.status === 'publication_unknown' ||
    draw.status === 'publishing'
  ) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`tas:verify:${draw.id}`)
        .setLabel('Vérifier la publication')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return {
    content:
      `Identifiant : \`${draw.id}\`\n` +
      'CSV : tous les participants et exclusions. ' +
      'JSON : règles et trace du tirage.',
    embeds: [embed],
    components: row.components.length ? [row] : [],
    attachments: [],
    files: exportsFor(draw),
    allowedMentions: { parse: [] },
  };
}

function publicMessage(draw) {
  return {
    content: disclaimer,

    embeds: [
      new EmbedBuilder()
        .setColor(0x133cc4)
        .setTitle('🎉 Résultats du tirage au sort')
        .setURL(link(draw.threadId))
        .setDescription(
          draw.winners
            .map((w, i) => `${i + 1}. <@${w.id}>`)
            .join('\n')
        )
        .addFields(
          {
            name: 'Lot par gagnant',
            value: draw.prize || 'Selon l’annonce initiale',
          },
          {
            name: 'Période de participation (Paris)',
            value:
              `Du ${draw.startText} inclus ` +
              `au ${draw.endText} exclu`,
          },
          {
            name: 'Participation',
            value:
              `${draw.eligible} personnes éligibles, ` +
              'une chance par personne. ' +
              `Maximum ${draw.maximum} messages.`,
          }
        )
        .setFooter({ text: `TAS ${draw.id}` }),
    ],

    allowedMentions: { parse: [] },
    nonce: draw.nonce,
    enforceNonce: true,
  };
}

async function publicationTarget(draw, needSend = true) {
  const guild = client.guilds.cache.get(guildId);

  const channel = await guild.channels.fetch(
    draw.publicationChannelId
  );

  if (
    !channel ||
    channel.guildId !== guildId ||
    !(
      [C.GuildText, C.GuildAnnouncement].includes(channel.type) ||
      channel.isThread()
    )
  ) {
    throw new UserError(
      'La destination doit être un salon texte, d’annonces ou un fil de ce serveur.'
    );
  }

  const me =
    channel.guild.members.me ||
    await channel.guild.members.fetchMe();

  const permissions = [
    P.ViewChannel,
    ...(
      needSend
        ? [
            P.EmbedLinks,
            channel.isThread()
              ? P.SendMessagesInThreads
              : P.SendMessages,
          ]
        : [P.ReadMessageHistory]
    ),
  ];

  if (!channel.permissionsFor(me)?.has(permissions)) {
    throw new UserError(
      'Permissions insuffisantes dans le salon de publication.'
    );
  }

  if (
    needSend &&
    channel.isThread() &&
    (channel.archived || channel.locked)
  ) {
    throw new UserError(
      'Le fil de publication est archivé ou verrouillé. Choisis un autre salon avec /tas-resultat et l’option publication.'
    );
  }

  return channel;
}

async function withDrawLock(id, task) {
  if (drawLocks.has(id)) {
    throw new UserError(
      'Une opération est déjà en cours sur ce tirage.'
    );
  }

  drawLocks.add(id);

  try {
    return await task(getDraw(id));
  } finally {
    drawLocks.delete(id);
  }
}

async function publish(id) {
  return withDrawLock(id, async draw => {
    if (draw.status === 'published') return draw;

    if (draw.status !== 'drawn') {
      throw new UserError(
        'Ce tirage ne peut pas être publié. Vérifie son état avec /tas-resultat.'
      );
    }

    if (draw.hash !== recordHash(draw)) {
      throw new UserError(
        'La trace du tirage a changé. Publication bloquée.'
      );
    }

    const channel = await publicationTarget(draw);

    draw.status = 'publishing';
    save();

    try {
      const message = await channel.send(publicMessage(draw));

      draw.status = 'published';
      draw.publicationMessageId = message.id;
      draw.publicationUrl =
        message.url || link(channel.id, message.id);
      draw.publishedAt = new Date().toISOString();

      save();
    } catch (error) {
      draw.status = 'publication_unknown';
      save();

      logError('Publication à vérifier', error);

      throw new UserError(
        'Envoi non confirmé. Aucun nouvel envoi automatique. Utilise le bouton Vérifier la publication ou /tas-resultat.'
      );
    }

    return draw;
  });
}

async function verifyPublication(id) {
  return withDrawLock(id, async draw => {
    if (draw.status === 'published') return draw;

    if (
      !['publishing', 'publication_unknown'].includes(draw.status)
    ) {
      throw new UserError(
        'Aucune publication incertaine à vérifier.'
      );
    }

    const channel = await publicationTarget(draw, false);

    const messages = await channel.messages.fetch({
      limit: 100,
      cache: false,
    });

    const found = messages.find(
      message =>
        message.author?.id === client.user.id &&
        message.embeds?.some(
          embed => embed.footer?.text === `TAS ${draw.id}`
        )
    );

    if (!found) {
      throw new UserError(
        'Aucune publication retrouvée parmi les 100 derniers messages. Vérifie le salon manuellement ; le bot ne republiera pas ce tirage automatiquement.'
      );
    }

    draw.status = 'published';
    draw.publicationMessageId = found.id;
    draw.publicationUrl =
      found.url || link(channel.id, found.id);

    save();

    return draw;
  });
}

function base(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(P.ManageGuild);
}

function publicationOption(command) {
  return command.addChannelOption(
    o => o
      .setName('publication')
      .setDescription(
        'Salon où publier les gagnants après validation'
      )
      .addChannelTypes(C.GuildText, C.GuildAnnouncement)
  );
}

const commands = [
  publicationOption(
    base(
      'tas',
      'Tirer au sort parmi les participants d’un fil ou post de forum'
    )
      .addStringOption(
        o => o
          .setName('fil')
          .setDescription(
            'Lien du fil, du post de forum ou du message d’annonce'
          )
          .setRequired(true)
          .setMaxLength(250)
      )
      .addIntegerOption(
        o => o
          .setName('gagnants')
          .setDescription(
            'Nombre de personnes à tirer au sort'
          )
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100)
      )
      .addIntegerOption(
        o => o
          .setName('maximum-messages')
          .setDescription(
            'Au-delà de ce nombre de messages, la personne est exclue'
          )
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10000)
      )
      .addStringOption(
        o => o
          .setName('debut')
          .setDescription(
            'Début inclus, heure de Paris : JJ/MM/AAAA HH:mm'
          )
          .setRequired(true)
          .setMaxLength(30)
      )
      .addStringOption(
        o => o
          .setName('fin')
          .setDescription(
            'Clôture exclue, heure de Paris : JJ/MM/AAAA HH:mm'
          )
          .setRequired(true)
          .setMaxLength(30)
      )
      .addStringOption(
        o => o
          .setName('lot')
          .setDescription(
            'Lot par gagnant, par exemple 60 fibettes'
          )
          .setMaxLength(200)
      )
  ),

  publicationOption(
    base(
      'tas-resultat',
      'Retrouver un tirage sauvegardé, ses gagnants et ses exports'
    )
      .addStringOption(
        o => o
          .setName('identifiant')
          .setDescription(
            'Identifiant indiqué dans le résultat du tirage'
          )
          .setRequired(true)
          .setMaxLength(36)
      )
  ),
];

async function runDraw(interaction) {
  const startText =
    interaction.options.getString('debut', true).trim();

  const endText =
    interaction.options.getString('fin', true).trim();

  const start = parseParis(startText);
  const end = parseParis(endText);

  if (start >= end) {
    throw new UserError(
      'La clôture doit être strictement après le début.'
    );
  }

  if (end > Date.now()) {
    throw new UserError(
      'La période n’est pas encore clôturée. Lance le tirage après la date et l’heure de fin.'
    );
  }

  const requested =
    interaction.options.getInteger('gagnants', true);

  const maximum =
    interaction.options.getInteger('maximum-messages', true);

  const thread = await resolveThread(
    interaction.guild,
    interaction.options.getString('fil', true)
  );

  const key = fingerprint(
    thread.id,
    start,
    end,
    maximum,
    requested
  );

  const previous = database.draws.find(
    d => d.key === key && d.status !== 'cancelled'
  );

  if (previous) {
    await interaction.editReply(preview(previous));
    return;
  }

  if (scanLocks.has(key)) {
    throw new UserError(
      'Une analyse identique est déjà en cours. Attends son résultat.'
    );
  }

  scanLocks.add(key);

  try {
    let lastProgress = Date.now();

    const report = await scan(
      thread,
      start,
      end,
      async progress => {
        if (Date.now() - lastProgress < 10000) return;

        lastProgress = Date.now();

        await interaction.editReply(
          `Analyse en cours : ${progress.scanned} messages parcourus, ` +
          `${progress.counted} commentaires comptés, ` +
          `${progress.users} personnes.`
        );
      }
    );

    const eligible = report.entries.filter(
      p => p.count >= 1 && p.count <= maximum
    );

    const draw = {
      id: randomUUID(),
      key,
      guildId,
      threadId: thread.id,
      threadName: thread.name,
      createdAt: new Date().toISOString(),
      createdBy: interaction.user.id,
      start,
      end,
      startText,
      endText,
      timeZone: 'Europe/Paris',
      maximum,
      requested,
      prize: interaction.options.getString('lot') || '',
      publicationChannelId:
        interaction.options.getChannel('publication')?.id ||
        defaultPublication ||
        thread.id,
      scanned: report.scanned,
      counted: report.counted,
      ignored: report.ignored,
      eligible: eligible.length,
      excluded: report.entries.length - eligible.length,
      entries: report.entries,
      winners:
        eligible.length >= requested
          ? sample(eligible, requested)
          : [],
      status:
        eligible.length >= requested
          ? 'drawn'
          : 'insufficient',
      nonce: randomBytes(10).toString('hex'),
    };

    draw.hash = recordHash(draw);
    database.draws.push(draw);

    // Les publications incertaines restent conservées.
    while (database.draws.length > maxSaved) {
      const index = database.draws.findIndex(
        d =>
          !['publishing', 'publication_unknown'].includes(d.status) &&
          !drawLocks.has(d.id) &&
          d.id !== draw.id
      );

      if (index < 0) break;

      database.draws.splice(index, 1);
    }

    save();

    await interaction.editReply(preview(draw));
  } finally {
    scanLocks.delete(key);
  }
}

async function handleInteraction(interaction) {
  const isCommand =
    interaction.isChatInputCommand() &&
    commands.some(c => c.name === interaction.commandName);

  const buttonMatch = interaction.isButton()
    ? interaction.customId.match(
        /^tas:(publish|cancel|verify):([0-9a-f-]{36})$/
      )
    : null;

  if (!isCommand && !buttonMatch) return;

  try {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    mustBeAuthorized(interaction);

    if (buttonMatch) {
      const [, action, id] = buttonMatch;
      let draw;

      if (action === 'publish') {
        draw = await publish(id);
      } else if (action === 'verify') {
        draw = await verifyPublication(id);
      } else {
        draw = await withDrawLock(id, async record => {
          if (record.status !== 'drawn') {
            throw new UserError(
              'Seul un tirage non publié peut être annulé.'
            );
          }

          record.status = 'cancelled';
          record.cancelledBy = interaction.user.id;

          save();

          return record;
        });
      }

      await interaction.editReply(preview(draw));
    } else if (interaction.commandName === 'tas') {
      await runDraw(interaction);
    } else {
      const id =
        interaction.options.getString('identifiant', true);

      const channel =
        interaction.options.getChannel('publication');

      const draw = channel
        ? await withDrawLock(id, async record => {
            if (record.status !== 'drawn') {
              throw new UserError(
                'La destination peut être modifiée seulement avant publication.'
              );
            }

            record.publicationChannelId = channel.id;
            save();

            return record;
          })
        : getDraw(id);

      await interaction.editReply(preview(draw));
    }
  } catch (error) {
    logError('TAS', error);

    const message = error instanceof UserError
      ? error.message
      : [50001, 50013, 10003, 10008].includes(Number(error?.code))
        ? 'Fil ou message inaccessible. Vérifie le lien, les permissions et l’accès aux fils privés.'
        : 'Erreur pendant l’opération. Aucun résultat partiel publié. Consulte les logs Railway ; un tirage déjà sauvegardé reste accessible avec /tas-resultat.';

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: message,
          embeds: [],
          components: [],
          attachments: [],
        });
      }
    } catch {
      // Aucune réponse publique de secours.
    }
  }
}

client.on(Events.InteractionCreate, interaction => {
  const job = handleInteraction(interaction);

  jobs.add(job);

  void job.then(
    () => jobs.delete(job),
    error => {
      jobs.delete(job);
      logError('Interaction', error);
    }
  );
});

client.on(
  Events.Error,
  error => logError('Discord', error)
);

async function main() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(
        new Error('Délai de connexion Discord dépassé')
      ),
      60000
    );

    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });

    client.login(token).catch(error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    throw new UserError(
      'Le bot n’est pas présent sur DISCORD_GUILD_ID. Vérifie son invitation et l’identifiant du serveur.'
    );
  }

  for (const command of commands) {
    await guild.commands.create(command.toJSON());
  }

  for (const draw of database.draws) {
    if (draw.status === 'publishing') {
      draw.status = 'publication_unknown';
    }
  }

  save();
  ready = true;

  console.log(
    `Bot TAS prêt : ${client.user.tag}. ` +
    `Serveur : ${guildId}. Heures : Europe/Paris.`
  );
}

async function shutdown(code = 0) {
  if (stopping) return;

  stopping = true;
  ready = false;

  const timer = setTimeout(
    () => process.exit(code),
    25000
  );

  await Promise.allSettled([...jobs]);

  try {
    save();
  } catch (error) {
    logError('Sauvegarde', error);
    code = 1;
  }

  clearTimeout(timer);
  client.destroy();
  process.exit(code);
}

process.once('SIGTERM', () => {
  void shutdown();
});

process.once('SIGINT', () => {
  void shutdown();
});

process.once('uncaughtException', error => {
  logError('Erreur fatale', error);
  void shutdown(1);
});

process.once('unhandledRejection', error => {
  logError('Erreur fatale', error);
  void shutdown(1);
});

if (require.main === module) {
  main().catch(error => {
    if (error instanceof UserError) {
      console.error(error.message);
    } else {
      logError('Démarrage', error);
    }

    void shutdown(1);
  });
}
