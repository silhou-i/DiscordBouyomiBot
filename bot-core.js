// Bot本体(GUIから開始・停止できる形に分離)
const { Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits } = require('discord.js');

// 読み上げ対象として一覧に出すチャンネル種別
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

// サーバー/チャンネル構成が変わったときに一覧を更新するイベント
const STRUCTURE_EVENTS = [
  Events.GuildCreate,
  Events.GuildDelete,
  Events.GuildUpdate,
  Events.ChannelCreate,
  Events.ChannelDelete,
  Events.ChannelUpdate,
];

const START_MESSAGE = '読み上げを開始しました';
const NO_CHANNEL_MESSAGE = '読み上げ対象のチャンネルが見つかりません。チャンネルIDを入力してください';

class BouyomiBot {
  constructor(log, onStatus, onChannels = () => {}) {
    this.log = log; // (level, message, meta?) => void
    this.onStatus = onStatus; // (status) => void  'stopped' | 'connecting' | 'running'
    this.onChannels = onChannels; // (guilds) => void  サーバー/チャンネル一覧
    this.client = null;
    this.settings = null;
    this.channelTimer = null;
  }

  get active() {
    return !!this.client;
  }

  async start(settings) {
    if (this.client) await this.stop();
    this.settings = settings;
    this.onStatus('connecting');

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      this.log('info', `ログインしました: ${c.user.tag}`);
      this.onStatus('running');
      this.emitChannels();
      // 読み上げ対象が1つもない場合は何も読み上げない(一覧からチャンネルを選んでもらう)
      if (this.settings.channelIds.length === 0) {
        this.log('error', NO_CHANNEL_MESSAGE);
        return;
      }
      // ログイン(再ログイン含む)のたびに、棒読みちゃん側で開始を知らせる
      speak(this.settings.bouyomiUrl, START_MESSAGE, this.log);
    });
    client.on(Events.MessageCreate, (m) => this.onMessage(m));
    client.on(Events.ShardDisconnect, (event, id) => {
      this.log('warn', `切断されました (shard ${id}, code ${event.code})`);
    });
    client.on(Events.Error, (err) => this.log('error', `クライアントエラー: ${err.message}`));
    for (const ev of STRUCTURE_EVENTS) {
      client.on(ev, () => this.scheduleChannels(client));
    }

    try {
      await client.login(settings.token);
    } catch (err) {
      this.log('error', `ログインに失敗しました: ${err.message}`);
      this.client = null;
      try { client.destroy(); } catch {}
      this.onStatus('stopped');
      throw err;
    }
  }

  async stop() {
    clearTimeout(this.channelTimer);
    this.channelTimer = null;
    if (this.client) {
      try { await this.client.destroy(); } catch {}
      this.client = null;
      this.log('info', '停止しました');
    }
    this.onStatus('stopped');
  }

  // 一覧の更新は短時間にまとめて1回だけ送る
  scheduleChannels(client) {
    if (this.client !== client) return;
    clearTimeout(this.channelTimer);
    this.channelTimer = setTimeout(() => {
      if (this.client === client) this.emitChannels();
    }, 500);
  }

  emitChannels() {
    try {
      this.onChannels(this.collectChannels());
    } catch (err) {
      this.log('error', `チャンネル一覧の取得に失敗しました: ${err.message}`);
    }
  }

  // Botが参加しているサーバーと、Botが閲覧できるチャンネルの一覧
  // [{ id, name, iconUrl, channels: [{ id, name, type: 'text'|'voice', category }] }]
  collectChannels() {
    if (!this.client) return [];
    const guilds = [...this.client.guilds.cache.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'ja'),
    );
    return guilds.map((g) => {
      const me = g.members.me;
      const channels = [...g.channels.cache.values()]
        .filter((ch) => TEXT_TYPES.includes(ch.type) || VOICE_TYPES.includes(ch.type))
        .filter((ch) => !me || ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel))
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          type: TEXT_TYPES.includes(ch.type) ? 'text' : 'voice',
          category: ch.parent?.name ?? null,
          sortKey: [
            ch.parent ? ch.parent.rawPosition : -1, // カテゴリなしを先頭に
            TEXT_TYPES.includes(ch.type) ? 0 : 1, // テキスト → ボイス
            ch.rawPosition,
          ],
        }))
        .sort((a, b) => {
          for (let i = 0; i < a.sortKey.length; i++) {
            if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] - b.sortKey[i];
          }
          return 0;
        })
        .map(({ sortKey, ...rest }) => rest);
      return {
        id: g.id,
        name: g.name,
        iconUrl: g.iconURL({ extension: 'png', size: 64 }) ?? null,
        channels,
      };
    });
  }

  // 発言本文(整形・文字数制限済み。発言者名は含まない)
  buildBody(message) {
    const { maxLength } = this.settings;
    let text = message.cleanContent
      .replace(/https?:\/\/\S+/g, 'URL省略')
      .replace(/<a?:(\w+):\d+>/g, '$1')
      .replace(/\|\|[\s\S]*?\|\|/g, 'ネタバレ')
      .replace(/```[\s\S]*?```/g, 'コードブロック省略')
      .replace(/\s+/g, ' ')
      .trim();

    if (message.attachments.size > 0) text = `${text} 添付ファイル`.trim();
    if (!text) return '';

    if (text.length > maxLength) text = text.slice(0, maxLength) + '、以下略';
    return text;
  }

  // 棒読みちゃんに送る文章(設定により発言者名を付ける)
  buildText(message) {
    const body = this.buildBody(message);
    if (!body) return '';
    if (!this.settings.readName) return body;
    const name = message.member?.displayName ?? message.author.username;
    return `${name}、${body}`;
  }

  // ログ表示用の「どこで・誰が」の情報
  buildMeta(message) {
    const member = message.member;
    const author = message.author;
    // ロール色(ロールの色が未設定のときは null)
    const color =
      member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : null;
    // サーバー別のアイコンがあればそれ、なければ通常のアイコン(取得できなければ null)
    const avatarSrc = [member, author].find((o) => typeof o?.displayAvatarURL === 'function');
    return {
      server: message.guild?.name ?? '',
      channel: message.channel?.name ?? '',
      user: {
        name: member?.displayName ?? author.username,
        id: author.id,
        avatarUrl: avatarSrc ? avatarSrc.displayAvatarURL({ extension: 'png', size: 32 }) : null,
        color,
      },
    };
  }

  async onMessage(message) {
    if (message.author.bot || !message.guild) return;
    // 読み上げ対象のチャンネルが選ばれていなければ、何も読み上げない
    const ids = this.settings.channelIds;
    if (!ids.includes(message.channelId)) return;

    const text = this.buildText(message);
    if (!text) return;
    this.log('read', this.buildBody(message), this.buildMeta(message));
    await speak(this.settings.bouyomiUrl, text, this.log);
  }
}

async function speak(baseUrl, text, log) {
  const url = `${baseUrl.replace(/\/+$/, '')}/talk?text=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) log('error', `棒読みちゃん応答エラー: ${res.status}`);
    return res.ok;
  } catch (err) {
    log('error', `棒読みちゃんに接続できません(起動とHTTP連携プラグインを確認): ${err.message}`);
    return false;
  }
}

module.exports = { BouyomiBot, speak, START_MESSAGE, NO_CHANNEL_MESSAGE };
