/* SharedSync — 共有ページ(GitHub Pages)で「誰が何を選んだか」を Firebase Realtime Database 越しに
   自動共有するための小さな層。ページ本体からは配列(ids)の出し入れだけを見せる。

   使い方(classic script。本体スクリプトより前に読み込む):
     <script src="sync.js"></script>
     const sync = SharedSync.start({
       config: {...},                       // Firebase の設定。null / 未指定なら同期しない
       people: ['nakada', 'hachiya'],       // 共有する人のキー
       storageKey: 'tgs2026-room',          // 部屋キーを覚える localStorage のキー
       hashParam: 'r',                      // #r=<部屋キー>
       path: 'wants',                       // rooms/<部屋キー>/<path>/<who>
       onRemote(who, ids) {},               // 相手(や別端末の自分)の変更が届いたとき
       getLocal(who) { return who === me ? ids : null; },  // 遠隔が空のときに送る配列。送らない人には null を返す
       onStatus(text, live) {},             // 状態表示。live=true で接続中
       strings: {},                         // 文言の差し替え(任意)
       hash: location.hash,                 // 読み込み時の hash を自分で渡す場合(任意)
     });
     sync.push(who, ids);   // 手元が変わったとき
     sync.key              // 有効な部屋キー(無ければ null)。招待リンクに付ける
     sync.live             // 同期を行う構成かどうか(設定と部屋キーが揃っている)

   注意: 部屋キーは秘密。リンクでのみ配り、ページの中には焼き込まない。
*/
(function () {
  'use strict';
  var HASH0 = location.hash || '';           // 本体が hash を消す前に控える
  var ROOM_RE = /^[A-Za-z0-9_-]{32,64}$/;    // 部屋キーは 32〜64 文字
  var FB_VER = '12.19.0';
  var FB_BASE = 'https://www.gstatic.com/firebasejs/' + FB_VER + '/';
  var DEFAULT_STRINGS = {
    noConfig: 'このページでは自動同期できません。共有コードで送り合ってください。',
    noKey: '同期リンクで開いてください(同期リンクには部屋キーが付いています)',
    badKey: '同期: 部屋キーが無効です',
    connecting: '同期: 接続中…',
    connected: '同期: 接続中(Firebase)',
    offline: '同期: 読み込めませんでした(オフライン?)。共有コードを使ってください。',
    denied: '同期: 部屋キーが無効です',
    error: '同期: エラー(%s)',
  };

  function readKey(hash, storageKey, param) {
    var m = new RegExp('[#&]' + param + '=([^&]+)').exec(hash || '');
    if (m) {
      var k;
      try { k = decodeURIComponent(m[1]); } catch (e) { k = m[1]; }
      if (ROOM_RE.test(k)) {
        if (storageKey) { try { localStorage.setItem(storageKey, k); } catch (e) {} }
        return { key: k, bad: false };
      }
      return { key: null, bad: true };  // 不正な #r= は保存済みの鍵で誤魔化さない
    }
    if (storageKey) {
      try { var s = localStorage.getItem(storageKey); if (s && ROOM_RE.test(s)) return { key: s, bad: false }; } catch (e) {}
    }
    return { key: null, bad: false };
  }

  function start(o) {
    o = o || {};
    var S = {}; for (var k in DEFAULT_STRINGS) S[k] = DEFAULT_STRINGS[k];
    for (var k2 in (o.strings || {})) S[k2] = o.strings[k2];
    var people = o.people || [];
    var path = o.path || 'wants';
    function status(t, live) { if (o.onStatus) o.onStatus(t, !!live); }
    function errText(e) {
      var m = String((e && (e.code || e.message)) || e || '');
      return /permission[_ ]?denied/i.test(m) ? S.denied : S.error.replace('%s', m.slice(0, 80));
    }

    var r = readKey(o.hash != null ? o.hash : HASH0, o.storageKey, o.hashParam || 'r');
    var api = { key: r.key, live: !!(o.config && r.key && !r.bad), push: function () {} };
    if (!o.config) { status(S.noConfig, false); return api; }
    if (r.bad) { status(S.badKey, false); return api; }
    if (!r.key) { status(S.noKey, false); return api; }

    var writing = {}, pending = {}, pushFn = null;
    api.push = function (who, ids) { if (pushFn) pushFn(who, ids); else pending[who] = ids; };
    status(S.connecting, false);

    (async function boot() {
      var A, R;
      try {
        var mods = await Promise.all([import(FB_BASE + 'firebase-app.js'), import(FB_BASE + 'firebase-database.js')]);
        A = mods[0]; R = mods[1];
      } catch (e) { status(S.offline, false); return; }
      var rdb;
      try { rdb = R.getDatabase(A.initializeApp(o.config)); } catch (e) { status(errText(e), false); return; }
      var ref = function (who) { return R.ref(rdb, 'rooms/' + r.key + '/' + path + '/' + who); };
      pushFn = function (who, ids) {
        writing[who] = true;
        R.set(ref(who), { ids: JSON.stringify(ids || []), ts: Date.now() })
          .catch(function (e) { status(errText(e), false); })
          .finally(function () { writing[who] = false; });
      };
      var ok = false, pushedEmpty = {};
      people.forEach(function (who) {
        R.onValue(ref(who), function (snap) {
          if (!ok) { ok = true; status(S.connected, true); }
          var v = snap.val();
          if (!v) {  // 遠隔にまだ無い: 送るべき手元の内容があれば一度だけ送る
            if (!pushedEmpty[who]) {
              var mine = o.getLocal ? o.getLocal(who) : null;
              if (Array.isArray(mine) && mine.length) { pushedEmpty[who] = true; pushFn(who, mine); }
            }
            return;
          }
          if (writing[who]) return;  // 自分の書き込みの反響は無視
          var ids = [];
          try { ids = typeof v.ids === 'string' ? JSON.parse(v.ids) : v.ids; } catch (e) { ids = []; }
          if (o.onRemote) o.onRemote(who, Array.isArray(ids) ? ids : []);
        }, function (e) { status(errText(e), false); });
      });
      Object.keys(pending).forEach(function (who) { pushFn(who, pending[who]); });
      pending = {};
    })();

    return api;
  }

  window.SharedSync = { start: start, hash: HASH0, ROOM_RE: ROOM_RE, version: FB_VER };
})();
