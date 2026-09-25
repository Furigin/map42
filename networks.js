/* Соцсети: подписи, цвета, распознавание ссылок. Общие для карты и панели штаба. */
(() => {
  "use strict";

  // id, подпись, цвет, домены
  const NETWORKS = [
    ["youtube", "YouTube", "#FF3B3B", ["youtube.com", "youtu.be"]],
    ["telegram", "Telegram", "#2AABEE", ["t.me", "telegram.me", "telegram.dog"]],
    ["tiktok", "TikTok", "#00F0D0", ["tiktok.com"]],
    ["vk", "ВКонтакте", "#4C6FFF", ["vk.com", "vk.ru", "vkvideo.ru", "vk.link"]],
    ["twitch", "Twitch", "#A06BFF", ["twitch.tv"]],
    ["instagram", "Instagram", "#FF4FA3", ["instagram.com"]],
    ["x", "X / Twitter", "#E9E9EF", ["x.com", "twitter.com"]],
    ["discord", "Discord", "#9FA8FF", ["discord.gg", "discord.com"]],
    ["yandex_music", "Яндекс Музыка", "#FFD21F", ["music.yandex.ru", "music.yandex.com", "music.yandex.kz", "music.yandex.by"]],
    ["spotify", "Spotify", "#1ED760", ["spotify.com", "spotify.link"]],
    ["apple_music", "Apple Music", "#FA5770", ["music.apple.com"]],
    ["soundcloud", "SoundCloud", "#FF9A3C", ["soundcloud.com"]],
    ["reddit", "Reddit", "#FF5A1F", ["reddit.com", "redd.it"]],
    ["kick", "Kick", "#B6FF3A", ["kick.com"]],
    ["rutube", "Rutube", "#6EE7B7", ["rutube.ru"]],
    ["dzen", "Дзен", "#C9C9D6", ["dzen.ru"]],
    ["boosty", "Boosty", "#F5793B", ["boosty.to"]],
    ["ok", "Одноклассники", "#FFB020", ["ok.ru"]],
    ["threads", "Threads", "#B8B8C8", ["threads.net", "threads.com"]],
    ["pinterest", "Pinterest", "#E60033", ["pinterest.com", "pin.it"]],
    ["steam", "Steam", "#66C0F4", ["steamcommunity.com", "store.steampowered.com"]],
    ["other", "Другое", "#8A8FA8", []],
  ];
  const META = NETWORKS.map(([id, name, color]) => ({ id, name, color }));

  function detect(host) {
    host = host.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    let best = "other", bestLen = 0; // длинный домен побеждает: music.yandex.ru важнее yandex.ru
    for (const [id, , , domains] of NETWORKS)
      for (const d of domains)
        if ((host === d || host.endsWith("." + d)) && d.length > bestLen) { best = id; bestLen = d.length; }
    return best;
  }

  /** Приводит ввод к ссылке: «@канал» → t.me, без https — дописывает. null, если это не ссылка. */
  function normalize(raw) {
    let s = String(raw || "").trim().split(/\s+/)[0] || "";
    if (!s) return null;
    if (/^@[A-Za-z0-9_]{4,}$/.test(s)) return `https://t.me/${s.slice(1)}`;
    if (!/^https?:\/\//i.test(s)) {
      if (!s.includes(".")) return null;
      s = "https://" + s;
    }
    try {
      const u = new URL(s);
      return u.hostname.includes(".") ? u.href : null;
    } catch { return null; }
  }

  /**
   * Ссылка → место: { net, key, url, handle }. Пост/видео сводится к каналу, где это понятно по ссылке,
   * чтобы повторные заходы попадали в одну точку. Ключ сравнивается без учёта регистра.
   */
  function canonical(link) {
    const u = new URL(link);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const net = detect(host);
    const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const first = segs[0] || "";
    const mk = (path, handle = null, base = host) =>
      ({ net, key: `${net}:${path.toLowerCase()}`, url: `https://${base}/${path}`, handle });

    if (net === "telegram" && first) {
      if ((first === "s" || first === "c") && segs[1]) return mk(segs[1], "@" + segs[1], "t.me");
      if (first.startsWith("+") || first === "joinchat")
        return mk(first.startsWith("+") ? first : "+" + (segs[1] || ""), null, "t.me");
      return mk(first, "@" + first, "t.me");
    }
    if (net === "youtube" && first) {
      if (first.startsWith("@")) return mk(first, first, "www.youtube.com");
      if (["channel", "c", "user"].includes(first) && segs[1]) return mk(`${first}/${segs[1]}`, segs[1], "www.youtube.com");
    }
    if (net === "tiktok" && first.startsWith("@")) return mk(first, first, "www.tiktok.com");
    if (net === "twitch" && first && !["videos", "directory", "p"].includes(first)) return mk(first, first, "www.twitch.tv");
    if (net === "kick" && first) return mk(first, first, "kick.com");
    if (net === "vk" && first) {
      const m = /wall(-?\d+)_/.exec(u.searchParams.get("w") || first);
      if (m) return mk(m[1].startsWith("-") ? `club${m[1].slice(1)}` : `id${m[1]}`, null, "vk.com");
      return mk(first, first, "vk.com");
    }
    if (net === "x" && first && !["i", "search", "hashtag"].includes(first)) return mk(first, "@" + first, "x.com");
    if (net === "instagram" && first && !["p", "reel", "reels", "stories", "explore"].includes(first))
      return mk(first, "@" + first, "www.instagram.com");
    if (net === "reddit" && ["r", "u", "user"].includes(first) && segs[1]) return mk(`${first}/${segs[1]}`, `${first}/${segs[1]}`, "www.reddit.com");
    if (net === "discord" && first) {
      if (host === "discord.gg") return mk(first, null, "discord.gg");
      if (first === "invite" && segs[1]) return mk(segs[1], null, "discord.gg");
    }
    if (net === "boosty" && first) return mk(first, first, "boosty.to");
    if (net === "dzen" && first) return mk(first, first, "dzen.ru");
    if (net === "rutube" && first === "channel" && segs[1]) return mk(`channel/${segs[1]}`, null, "rutube.ru");
    if (net === "soundcloud" && first) return mk(first, first, "soundcloud.com");

    // по умолчанию: хост + путь без хвостов; одно видео YouTube — один ключ, как бы ни прислали ссылку
    let h = host, path = segs.join("/");
    if (net === "youtube") {
      let vid = u.searchParams.get("v");
      if (host === "youtu.be" && first) vid = first;
      else if (["shorts", "live"].includes(first) && segs[1]) vid = segs[1];
      if (vid) { h = "youtube.com"; path = `watch?v=${vid}`; }
    }
    return { net, key: `${net}:${h}/${path.toLowerCase()}`.replace(/\/$/, ""), url: `https://${h}/${path}`.replace(/\/$/, ""), handle: null };
  }

  /** «12к», «1,5 млн», «12 345», «1.2M» → число; null, если не число. */
  function parseCount(text) {
    const t = String(text || "").toLowerCase().replace(/[  ]/g, " ").trim();
    const m = /^~?\s*([\d\s]*\d[\d\s]*(?:[.,]\d+)?)\s*(k|к|тыс\.?|m|м|млн\.?|b|млрд\.?)?\s*\+?$/.exec(t);
    if (!m) return null;
    const num = m[1].replace(/\s/g, ""), suf = (m[2] || "").replace(/\.$/, "");
    const mult = { k: 1e3, "к": 1e3, "тыс": 1e3, m: 1e6, "м": 1e6, "млн": 1e6, b: 1e9, "млрд": 1e9 }[suf];
    if (mult) return Math.round(parseFloat(num.replace(",", ".")) * mult);
    if (/^\d{1,3}([.,]\d{3})+$/.test(num)) return parseInt(num.replace(/[.,]/g, ""), 10);
    const v = Math.round(parseFloat(num.replace(",", ".")));
    return Number.isFinite(v) ? v : null;
  }

  window.AtlasNet = { NETWORKS: META, detect, normalize, canonical, parseCount };
})();
