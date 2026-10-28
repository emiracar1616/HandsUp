import { auth, db } from './firebase.js';
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updateProfile, sendPasswordResetEmail, reauthenticateWithCredential, EmailAuthProvider, deleteUser,
  sendEmailVerification, reload
} from 'firebase/auth';
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, where,
  writeBatch, arrayUnion, arrayRemove
} from 'firebase/firestore';
import { App as CapApp } from '@capacitor/app';
import { esc, money, parseAmount, computeStats, settlements } from './logic.js';
import './style.css';

/* ---------- Durum ---------- */
const S = {
  booting: true, user: null, ready: false, loadError: '',
  trips: [], exps: {}, names: {},
  view: null, lastTrip: null, armed: {},
  editing: null, pendingForm: null, formSig: '',
  found: null, searchMsg: '', busy: {},
  authMode: 'login', registering: false,
  online: navigator.onLine !== false,
  /* Kimlik akışı: null | 'verify' | 'setup' | 'app' */
  gate: null, pendingProfile: null, profileReady: false,
  /* Gezinin dışındaki ekranlar: 'list' | 'new' | 'profile' */
  page: 'list', newMembers: [], newSuggestMsg: '',
  pendingReceipt: undefined, myNick: '', myEmoji: '🙂', myPhoto: null, myIban: ''
};
const NICK_RE = /^[a-z0-9_]{3,20}$/;
const EMOJIS = ['🙂', '😎', '🦊', '🐼', '🐯', '🌵', '🚀', '🏖️', '⛰️', '🍕', '🎒', '🌊', '⭐', '🎈', '🧭', '🐢'];
const THEME_KEY = 'gezi-theme';
const SCREENS = ['screenAuth', 'screenVerify', 'screenSetup', 'screenList', 'screenNew', 'screenProfile', 'screenTrip'];
let tripsUnsub = null;
const expUnsubs = {};
const MAX_TRIPS_LIVE = 40;

/* ---------- Yardımcılar ---------- */
const $ = (id) => document.getElementById(id);
const myId = () => (S.user ? S.user.uid : null);
const rawName = (id) => (S.names[id] && S.names[id].name) || '';
/* Kullanıcı belgesinden önbellek kaydı */
const pickUser = (d) => ({ name: d.name || '', emoji: d.emoji || '', photo: d.photo || null, iban: d.iban || '' });
/* Avatar: fotoğraf varsa o, yoksa emoji */
const avatarHTML = (id, cls) => {
  const u = S.names[id] || {};
  if (u.photo) return '<span class="' + cls + '"><img alt="" src="' + esc(u.photo) + '"></span>';
  return '<span class="' + cls + '">' + esc(u.emoji || '🙂') + '</span>';
};
const nameOf = (id) => (rawName(id) || 'Biri') + (id === myId() ? ' (sen)' : '');
const shortName = (id) => (id === myId() ? 'Sen' : (rawName(id) || 'Biri'));

function setMsg(id, text, ok) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function errText(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return 'Bu işlem için yetkin yok. (Firestore güvenlik kuralları yüklenmemiş olabilir.)';
  if (c === 'unavailable' || c === 'deadline-exceeded') return 'Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.';
  if (c === 'resource-exhausted') return 'Kullanım sınırı doldu, biraz bekleyip tekrar dene.';
  return 'Kaydedilemedi. Bağlantını kontrol edip tekrar dene.';
}

function authErr(e) {
  switch (e && e.code) {
    case 'auth/invalid-email': return 'E-posta adresi geçersiz.';
    case 'auth/missing-password': return 'Şifreni yaz.';
    case 'auth/email-already-in-use': return 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.';
    case 'auth/weak-password': return 'Şifre en az 6 karakter olmalı.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials': return 'E-posta ya da şifre hatalı.';
    case 'auth/too-many-requests': return 'Çok fazla deneme yapıldı. Biraz bekleyip tekrar dene.';
    case 'auth/network-request-failed': return 'İnternet bağlantısı yok ya da sunucuya ulaşılamıyor.';
    case 'auth/operation-not-allowed': return 'E-posta/şifre girişi Firebase konsolunda etkin değil (Authentication > Sign-in method).';
    case 'auth/requires-recent-login': return 'Güvenlik için çıkış yapıp yeniden giriş yaptıktan sonra tekrar dene.';
    default: return 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.';
  }
}

/* ---------- Hesaplama (saf fonksiyonlar logic.js içinde) ---------- */
const tripExps = (t) => S.exps[t.id] || [];
const stats = (t) => computeStats(t.memberIds || [], tripExps(t));

function curTrip() {
  if (!S.view) return null;
  return S.trips.find((t) => t.id === S.view) || null;
}

function usedInExpenses(t, id) {
  return tripExps(t).some((e) => e.payerId === id || (e.amongIds || []).indexOf(id) !== -1);
}

/* İki dokunuşla onay: ilk dokunuş "Emin misin?" gösterir, 3,5 sn içinde ikincisi işlemi yapar */
function confirmArm(key) {
  if (S.armed[key]) {
    clearTimeout(S.armed[key]);
    delete S.armed[key];
    return true;
  }
  S.armed[key] = setTimeout(() => { delete S.armed[key]; renderAll(); }, 3500);
  renderAll();
  return false;
}

/* ---------- İsim çözme ---------- */
function ensureNames(ids) {
  ids.forEach((id) => {
    if (!id || id in S.names) return;
    S.names[id] = { name: '' };
    getDoc(doc(db, 'users', id)).then((s) => {
      if (s.exists()) {
        S.names[id] = pickUser(s.data());
        renderAll();
      }
    }).catch(() => {});
  });
}

function collectIds() {
  const ids = [myId()];
  if (S.found) ids.push(S.found.id);
  S.trips.forEach((t) => {
    (t.memberIds || []).forEach((i) => ids.push(i));
    tripExps(t).forEach((e) => {
      ids.push(e.payerId);
      (e.amongIds || []).forEach((i) => ids.push(i));
    });
  });
  return ids;
}

/* ---------- Çizim ---------- */
let renderPending = false;
function renderAll() {
  if (renderPending) return;
  renderPending = true;
  Promise.resolve().then(() => { renderPending = false; doRender(); });
}

function show(id, on) { $(id).hidden = !on; }

function setScreen(id) { SCREENS.forEach((s) => show(s, s === id)); }

/* Üst çubuk ve geri düğmesi: yalnızca giriş yapılmış ve hazırken görünür */
function updateChrome(on, t) {
  $('appbar').hidden = !on;
  if (!on) return;
  const inSub = !!t || S.page !== 'list';
  $('backBtn').hidden = !inSub;
  let title = 'Gezi Hesabı';
  if (t) title = t.name;
  else if (S.page === 'new') title = 'Yeni gezi';
  else if (S.page === 'profile') title = 'Profil';
  $('brandTitle').textContent = title;
  $('profileBtn').innerHTML = avatarHTML(myId(), 'avatar-fill');
}

function doRender() {
  const notice = $('notice');
  const banner = $('banner');

  const bannerText = !S.online
    ? 'İnternet bağlantısı yok. Yaptığın değişiklikler bağlantı gelince kaydedilir.'
    : (S.loadError || '');
  banner.hidden = !bannerText;
  banner.textContent = bannerText;

  const loading = (text) => {
    notice.hidden = false;
    notice.innerHTML = '<p class="muted">' + esc(text) + '</p>';
    SCREENS.forEach((s) => show(s, false));
    updateChrome(false);
  };

  if (S.booting) { loading('Yükleniyor…'); return; }

  if (!S.user) {
    notice.hidden = true;
    updateChrome(false);
    setScreen('screenAuth');
    renderAuth();
    return;
  }

  if (S.gate === 'verify') {
    notice.hidden = true;
    updateChrome(false);
    setScreen('screenVerify');
    $('verifyText').textContent = (S.user.email || 'E-posta adresin') +
      ' adresine doğrulama bağlantısı gönderdik. Bağlantıya tıkladıktan sonra aşağıdaki düğmeye bas.';
    return;
  }

  if (S.gate === 'setup') {
    notice.hidden = true;
    updateChrome(false);
    setScreen('screenSetup');
    return;
  }

  ensureNames(collectIds());

  if (!S.ready) { loading('Gezilerin yükleniyor…'); return; }
  notice.hidden = true;

  const t = curTrip();
  updateChrome(true, t);
  if (t) {
    setScreen('screenTrip');
    renderTrip(t);
  } else if (S.page === 'new') {
    setScreen('screenNew');
    renderNew();
  } else if (S.page === 'profile') {
    setScreen('screenProfile');
    renderProfile();
  } else {
    setScreen('screenList');
    renderList();
  }
  show('fabNew', !t && S.page === 'list');
}

function renderAuth() {
  const reg = S.authMode === 'register';
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.authMode));
  show('nameRow', reg);
  $('authBtn').textContent = S.busy.auth ? 'Lütfen bekle…' : (reg ? 'Kayıt ol' : 'Giriş yap');
  $('authBtn').disabled = !!S.busy.auth;
  $('authPass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  show('resetBtn', !reg);
}

/* Genel özet: tüm gezilerdeki alacak ve borç, para birimi bazında */
function renderSummary() {
  const uid = myId();
  const totals = {};
  S.trips.forEach((t) => {
    const cur = t.currency || '₺';
    const v = stats(t).net[uid] || 0;
    totals[cur] = totals[cur] || { pos: 0, neg: 0 };
    if (v > 0) totals[cur].pos += v;
    else if (v < 0) totals[cur].neg += -v;
  });
  const curs = Object.keys(totals);
  if (!S.trips.length) { $('summaryBox').innerHTML = '<div class="empty">Henüz gezin yok.</div>'; return; }
  if (!curs.length) { $('summaryBox').innerHTML = '<div class="big-sum">Hesabın kapalı</div>'; return; }
  $('summaryBox').innerHTML = curs.map((c) => {
    const x = totals[c];
    return '<div class="sum-row"><span>Alacağın</span><b>' + esc(money(x.pos, c)) + '</b></div>' +
      '<div class="sum-row"><span>Borcun</span><b>' + esc(money(x.neg, c)) + '</b></div>';
  }).join('');
}

function renderList() {
  renderSummary();
  const box = $('tripList');
  if (!S.trips.length) {
    box.innerHTML = '<div class="empty">Henüz gezin yok. Sağ alttaki + ile ilk gezini oluştur.</div>';
    return;
  }
  const uid = myId();
  const trips = S.trips.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  box.innerHTML = '<ul class="tripul">' + trips.map((t) => {
    const st = stats(t);
    const net = st.net[uid] || 0;
    const cls = net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero';
    const txt = net > 0 ? money(net, t.currency) + ' alacaklı'
      : net < 0 ? money(net, t.currency) + ' borçlu'
        : (st.total ? 'Hesabın kapalı' : 'Harcama yok');
    return '<li><button type="button" class="tripcard" data-open="' + esc(t.id) + '">' +
      '<span class="tc-main"><strong>' + esc(t.name) + '</strong>' +
      '<span class="muted small">' + (t.memberIds || []).length + ' kişi · toplam ' + money(st.total, t.currency) + '</span></span>' +
      '<span class="pill ' + cls + '">' + esc(txt) + '</span></button></li>';
  }).join('') + '</ul>';
}

/* Yeni gezi: ad, para birimi, kişiler (önerilerle) */
function suggestedIds(exclude) {
  const seen = {};
  const out = [];
  const uid = myId();
  S.trips.forEach((tr) => (tr.memberIds || []).forEach((id) => {
    if (id === uid || seen[id] || exclude.indexOf(id) !== -1) return;
    seen[id] = 1;
    if (rawName(id)) out.push(id);
  }));
  return out;
}

function renderNew() {
  $('newMembers').innerHTML = S.newMembers.length
    ? S.newMembers.map((id) => '<span class="chip"><span class="who">' + avatarHTML(id, 'avatar') +
      '<span>' + esc(rawName(id) || 'Biri') + '</span></span>' +
      '<button type="button" data-rm-new="' + esc(id) + '" aria-label="Çıkar">×</button></span>').join('')
    : '<span class="muted small">Henüz kişi eklemedin. Sen zaten gezidesin.</span>';
  const sugg = suggestedIds(S.newMembers);
  $('newMemberSuggest').innerHTML = (sugg.length ? '<p class="hint" style="margin:0 0 4px">Önerilen kişiler</p>' : '') +
    sugg.slice(0, 8).map((id) => '<button type="button" class="person" data-add-new="' + esc(id) + '">' +
      avatarHTML(id, 'avatar') + '<span>' + esc(rawName(id)) + '</span><span class="plus">Ekle +</span></button>').join('');
  $('newMemberMsg').textContent = S.newSuggestMsg || '';
  $('createTripBtn').disabled = !!S.busy.create;
}

/* Profil: emoji, fotoğraf, ad, IBAN, tema */
function renderProfile() {
  const uid = myId();
  const u = S.names[uid] || {};
  $('profileAvatar').innerHTML = u.photo
    ? '<img alt="" src="' + esc(u.photo) + '">'
    : esc(u.emoji || '🙂');
  $('profileName').textContent = rawName(uid) || '';
  $('profileNick').textContent = S.myNick ? '@' + S.myNick : '';
  $('acctEmail').textContent = S.user.email || '';
  $('emojiPick').innerHTML = EMOJIS.map((e) =>
    '<button type="button" data-emoji="' + esc(e) + '" class="' + ((!u.photo && u.emoji === e) ? 'on' : '') + '">' + e + '</button>').join('');
  const th = getTheme();
  document.querySelectorAll('#themeSeg [data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === th));
}

function renderTrip(t) {
  const cur = t.currency || '₺';
  const uid = myId();
  const isOwner = t.ownerId === uid;
  const members = t.memberIds || [];

  if (S.lastTrip !== t.id) {
    S.lastTrip = t.id; S.found = null; S.searchMsg = ''; S.editing = null; S.pendingForm = null; S.formSig = '';
    $('memberEmail').value = ''; $('desc').value = ''; $('amount').value = ''; $('amtHint').textContent = '';
    setMsg('memberMsg', ''); setMsg('expMsg', ''); setMsg('toolMsg', '');
    $('copyOut').style.display = 'none';
    $('among').innerHTML = '';
    S.pendingReceipt = undefined; $('receiptPrev').hidden = true; $('receiptClear').hidden = true;
  }
  $('tripTitle').textContent = t.name;

  /* Kişiler */
  $('members').innerHTML = members.map((id) => {
    const canRemove = isOwner && id !== uid && !usedInExpenses(t, id);
    return '<span class="chip"><span class="who">' + avatarHTML(id, 'avatar') + '<span>' + esc(nameOf(id)) + '</span>' +
      (id === t.ownerId ? '<span class="badge">kurucu</span>' : '') + '</span>' +
      (canRemove
        ? '<button type="button" data-del-member="' + esc(id) + '" title="Geziden çıkar" aria-label="Geziden çıkar">×</button>'
        : '<span style="width:12px"></span>') +
      '</span>';
  }).join('');

  /* Kişi arama (e-posta ile) */
  show('addMemberBox', isOwner);
  if (isOwner) {
    const f = S.found;
    $('memberResults').innerHTML = (f && members.indexOf(f.id) === -1)
      ? '<button type="button" class="person" data-add-member="' + esc(f.id) + '"><span>' +
        esc(rawName(f.id) || 'İsimsiz kullanıcı') + '</span><span class="plus">Ekle +</span></button>'
      : '';
    $('memberHint').textContent = S.searchMsg ||
      (f ? '' : 'Arkadaşının nickname\'ini yaz.');
    /* Daha önce herhangi bir gezide birlikte olduğun kişiler öneri olarak */
    const seen = {};
    const sugg = [];
    S.trips.forEach((tr) => (tr.memberIds || []).forEach((id) => {
      if (id === myId() || members.indexOf(id) !== -1 || seen[id]) return;
      seen[id] = 1;
      if (rawName(id)) sugg.push(id);
    }));
    $('memberSuggest').innerHTML = (sugg.length ? '<p class="hint" style="margin:0 0 4px">Önerilen kişiler</p>' : '') +
      sugg.slice(0, 8).map((id) =>
        '<button type="button" class="person" data-add-member="' + esc(id) + '"><span>' +
        esc(rawName(id)) + '</span><span class="plus">Ekle +</span></button>').join('');
    $('memberFindBtn').disabled = !!S.busy.find;
  }

  /* Harcama formu (kişi listesi değişmedikçe seçenekleri yeniden kurma) */
  const sig = members.map((id) => id + ':' + nameOf(id)).join('|');
  const pf = S.pendingForm;
  if (pf || S.formSig !== sig) {
    const paySel = $('payer');
    const prev = pf ? pf.payer : paySel.value;
    paySel.innerHTML = members.map((id) =>
      '<option value="' + esc(id) + '">' + esc(nameOf(id)) + '</option>').join('');
    paySel.value = (prev && members.indexOf(prev) !== -1) ? prev
      : (members.indexOf(uid) !== -1 ? uid : (members[0] || ''));

    const checked = {};
    if (pf) members.forEach((id) => { checked[id] = pf.among.indexOf(id) !== -1; });
    else document.querySelectorAll('#among input').forEach((i) => { checked[i.value] = i.checked; });
    $('among').innerHTML = members.map((id) => {
      const on = (id in checked) ? checked[id] : true;
      return '<label><input type="checkbox" value="' + esc(id) + '"' + (on ? ' checked' : '') + '> ' + esc(shortName(id)) + '</label>';
    }).join('');
    S.formSig = sig;
    S.pendingForm = null;
  }

  if (S.editing && !tripExps(t).some((e) => e.id === S.editing)) S.editing = null;
  $('formTitle').textContent = S.editing ? 'Harcamayı düzenle' : 'Harcama ekle';
  $('addExpenseBtn').textContent = S.editing ? 'Değişikliği kaydet' : 'Harcamayı ekle';
  show('cancelEditBtn', !!S.editing);

  /* Özet */
  const st = stats(t);
  const my = st.net[uid] || 0;
  const big = my > 0 ? money(my, cur) + ' alacaklısın'
    : my < 0 ? money(my, cur) + ' borçlusun'
      : (st.total ? 'Hesabın kapalı' : 'Henüz harcama yok');
  $('hero').innerHTML =
    '<span class="muted">Senin durumun</span>' +
    '<div class="big ' + (my > 0 ? 'pos' : my < 0 ? 'neg' : '') + '">' + esc(big) + '</div>' +
    '<div class="stats">' +
    '<div><span class="muted">Gezinin toplamı</span><b>' + money(st.total, cur) + '</b></div>' +
    '<div><span class="muted">Senin ödediğin</span><b>' + money(st.paid[uid] || 0, cur) + '</b></div>' +
    '<div><span class="muted">Senin payın</span><b>' + money(st.share[uid] || 0, cur) + '</b></div>' +
    '</div>';

  /* Ödeme önerileri */
  const sets = settlements(st.net).sort((a, b) => {
    const am = (a.from === uid || a.to === uid) ? 0 : 1;
    const bm = (b.from === uid || b.to === uid) ? 0 : 1;
    return am - bm;
  });
  if (!tripExps(t).length) {
    $('settle').innerHTML = '<div class="empty">Harcama girince önerilen ödemeler burada görünür.</div>';
  } else if (!sets.length) {
    $('settle').innerHTML = '<div class="empty">Kimsenin kimseye borcu yok.</div>';
  } else {
    $('settle').innerHTML = '<ul>' + sets.map((s) => {
      const mine = s.from === uid || s.to === uid;
      return '<li class="item' + (mine ? ' mine' : '') + '"><div class="pay"><strong>' + esc(shortName(s.from)) +
        '</strong><span class="arrow">→</span><strong>' + esc(shortName(s.to)) + '</strong></div>' +
        '<div><span class="amt">' + money(s.amount, cur) + '</span>' +
          (S.names[s.to] && S.names[s.to].iban ? '<br><button type="button" class="btn ghost small iban-btn" data-copy-iban="' + esc(s.to) + '">IBAN kopyala</button>' : '') +
          '</div></li>';
    }).join('') + '</ul>';
  }

  /* Bakiyeler */
  const ids = Object.keys(st.net).sort((a, b) => (a === uid ? -1 : b === uid ? 1 : 0));
  $('balances').innerHTML = '<ul>' + ids.map((id) => {
    const v = st.net[id] || 0;
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted';
    const txt = v > 0 ? money(v, cur) + ' alacaklı' : v < 0 ? money(v, cur) + ' borçlu' : 'Hesabı kapalı';
    return '<li class="item"><strong>' + esc(nameOf(id)) + '</strong><span class="amt ' + cls + '">' + esc(txt) + '</span></li>';
  }).join('') + '</ul>';

  /* Harcamalar */
  const list = tripExps(t).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!list.length) {
    $('expenses').innerHTML = '<div class="empty">Henüz harcama yok.</div>';
  } else {
    $('expenses').innerHTML = '<div class="total"><span>Toplam harcama</span><span>' + money(st.total, cur) + '</span></div><ul>' +
      list.map((e) => {
        const among = e.amongIds || [];
        const who = among.length === members.length ? 'herkes' : among.map(shortName).join(', ');
        const canEdit = e.by === uid || isOwner;
        const armedDel = !!S.armed['exp:' + e.id];
        return '<li class="item"><div><strong>' + esc(e.desc) + '</strong><br><span class="muted">' +
          esc(shortName(e.payerId)) + ' ödedi · ' + esc(who) + ' arasında</span></div>' +
          '<div><div class="amt">' + money(e.amount, cur) + '</div>' +
            (e.receipt ? '<button type="button" class="receipt-link" data-receipt="' + esc(e.id) + '">Fişi gör</button>' : '') +
          (canEdit
            ? '<div class="actions"><button class="ghost small" type="button" data-edit-exp="' + esc(e.id) + '">Düzenle</button>' +
              '<button class="ghost small danger" type="button" data-del-exp="' + esc(e.id) + '">' + (armedDel ? 'Emin misin?' : 'Sil') + '</button></div>'
            : '') +
          '</div></li>';
      }).join('') + '</ul>';
  }

  /* Araçlar */
  show('leaveBtn', !isOwner);
  show('deleteTripBtn', isOwner);
  $('leaveBtn').textContent = S.armed.leave ? 'Emin misin? Tekrar dokun' : 'Geziden ayrıl';
  $('deleteTripBtn').textContent = S.armed.deltrip ? 'Herkes için silinecek. Tekrar dokun' : 'Geziyi sil';
}

function updateAmtHint() {
  const t = curTrip();
  const el = $('amtHint');
  const v = $('amount').value.trim();
  if (!v || !t) { el.textContent = ''; return; }
  const a = parseAmount(v);
  el.textContent = (isFinite(a) && a > 0) ? 'Okunan tutar: ' + money(a, t.currency) : 'Tutarı 125,50 gibi yaz.';
}

/* ---------- Hesap işlemleri ---------- */
function setAuthMode(mode) {
  S.authMode = mode;
  setMsg('authMsg', '');
  renderAll();
}

/* Profil: users/{uid} (ad, nickname) + usernames/{nick} (benzersizlik için) */
async function createProfile(user, name, nick) {
  const uid = user.uid;
  const batch = writeBatch(db);
  batch.set(doc(db, 'usernames', nick), { uid });
  batch.set(doc(db, 'users', uid), { name, nick, createdAt: Date.now() });
  await batch.commit();
}

/* Profil var mı? Yoksa kurulum ekranına gerek var. */
async function loadProfile(user) {
  const uid = user.uid;
  try {
    const s = await getDoc(doc(db, 'users', uid));
    if (s.exists() && s.data().nick) {
      S.names[uid] = pickUser(s.data());
      S.myNick = s.data().nick;
      S.profileReady = true;
    } else {
      S.profileReady = false;
    }
  } catch (e) {
    S.profileReady = false;
    console.warn('Profil yüklenemedi', e);
  }
  return S.profileReady;
}

/* Kullanıcının durumuna göre ekranı belirle: doğrulama -> profil -> uygulama */
async function routeAfterLogin(user) {
  if (!user.emailVerified) {
    S.gate = 'verify';
    S.user = user;
    renderAll();
    return;
  }
  if (S.pendingProfile && S.pendingProfile.uid === user.uid) {
    try {
      await createProfile(user, S.pendingProfile.name, S.pendingProfile.nick);
      S.pendingProfile = null;
    } catch (e) {
      S.gate = 'setup';
      S.user = user;
      setMsg('setupMsg', 'Nickname alınmış olabilir. Başka bir nickname seç.');
      renderAll();
      return;
    }
  }
  const ok = await loadProfile(user);
  if (!ok) {
    S.gate = 'setup';
    S.user = user;
    renderAll();
    return;
  }
  S.gate = 'app';
  enterApp(user);
}

function stopListeners() {
  if (tripsUnsub) { tripsUnsub(); tripsUnsub = null; }
  Object.keys(expUnsubs).forEach((id) => { expUnsubs[id](); delete expUnsubs[id]; });
}

/* Dinleyici hata verirse (ör. gezi kaydı izin kurallarına henüz yansımadıysa) kapanır.
   Hatayı yutmak yerine kısa aralıklarla yeniden kuruyoruz. */
const retryTimers = {};
function attachExpenseListener(id, attempt) {
  if (expUnsubs[id]) { expUnsubs[id](); delete expUnsubs[id]; }
  expUnsubs[id] = onSnapshot(collection(db, 'trips', id, 'expenses'), (snap) => {
    S.exps[id] = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    renderAll();
  }, () => {
    if (expUnsubs[id]) { expUnsubs[id](); delete expUnsubs[id]; }
    if (attempt >= 5) return;
    clearTimeout(retryTimers[id]);
    retryTimers[id] = setTimeout(() => attachExpenseListener(id, attempt + 1), 800 * (attempt + 1));
  });
}

function syncExpenseSubs() {
  const want = {};
  S.trips.slice(0, MAX_TRIPS_LIVE).forEach((t) => { want[t.id] = 1; });
  Object.keys(expUnsubs).forEach((id) => {
    if (!want[id]) { expUnsubs[id](); delete expUnsubs[id]; delete S.exps[id]; }
  });
  Object.keys(want).forEach((id) => {
    if (expUnsubs[id]) return;
    attachExpenseListener(id, 0);
  });
}

/* Gezi listesi dinleyicisi. Hata olursa kısa aralıklarla yeniden dener. */
let tripsRetry = 0;
function attachTrips(uid) {
  if (tripsUnsub) { tripsUnsub(); tripsUnsub = null; }
  tripsUnsub = onSnapshot(
    query(collection(db, 'trips'), where('memberIds', 'array-contains', uid)),
    (snap) => {
      tripsRetry = 0;
      S.trips = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      if (S.view && !S.trips.some((t) => t.id === S.view) && !snap.metadata.hasPendingWrites) S.view = null;
      S.ready = true; S.loadError = '';
      syncExpenseSubs();
      renderAll();
    },
    (e) => {
      S.ready = true;
      S.loadError = 'Geziler yüklenemedi. ' + errText(e);
      renderAll();
      if (tripsRetry < 5) {
        tripsRetry++;
        setTimeout(() => { if (S.user && S.user.uid === uid) attachTrips(uid); }, 1000 * tripsRetry);
      }
    }
  );
}

function enterApp(user) {
  if (S.user && S.user.uid === user.uid && tripsUnsub) { S.user = user; renderAll(); return; }
  stopListeners();
  S.user = user; S.booting = false; S.ready = false; S.loadError = '';
  S.trips = []; S.exps = {}; S.view = null; S.lastTrip = null; S.page = 'list';
  renderAll();
  $('acctName').value = rawName(user.uid);
  $('acctEmail').textContent = user.email || '';
  attachTrips(user.uid);
}

/* Tüm verileri sıfırdan dinlemeye al: ön plana dönüş ve aşağı çekerek yenileme için */
let refreshing = false;
function refreshData() {
  if (!S.user || refreshing) return;
  refreshing = true;
  /* Diğer kişilerin önbelleğini de tazele (ör. IBAN değişmiş olabilir) */
  Object.keys(S.names).forEach((k) => { if (k !== myId()) delete S.names[k]; });
  stopListeners();
  S.ready = false;
  renderAll();
  attachTrips(S.user.uid);
  setTimeout(() => { refreshing = false; renderAll(); }, 700);
}

function leaveApp() {
  stopListeners();
  S.user = null; S.booting = false; S.ready = false; S.loadError = '';
  S.trips = []; S.exps = {}; S.names = {}; S.view = null; S.lastTrip = null;
  S.found = null; S.editing = null; S.armed = {}; S.authMode = 'login';
  S.gate = null; S.profileReady = false; S.myNick = ''; S.pendingProfile = null;
  setMsg('authMsg', '');
  $('authPass').value = ''; $('delPass').value = ''; $('acctName').value = '';
  renderAll();
}

async function submitAuth(ev) {
  ev.preventDefault();
  if (S.busy.auth) return;
  const reg = S.authMode === 'register';
  const email = $('authEmail').value.trim();
  const pass = $('authPass').value;
  const name = $('authName').value.trim();
  const nick = $('authNick').value.trim().toLowerCase();
  setMsg('authMsg', '');
  if (reg && !name) { setMsg('authMsg', 'Adını yaz.'); return; }
  if (reg && !NICK_RE.test(nick)) { setMsg('authMsg', 'Nickname 3-20 karakter olmalı: küçük harf, rakam ve alt çizgi.'); return; }
  if (!email) { setMsg('authMsg', 'E-posta adresini yaz.'); return; }
  if (!pass) { setMsg('authMsg', 'Şifreni yaz.'); return; }
  if (reg && pass.length < 6) { setMsg('authMsg', 'Şifre en az 6 karakter olmalı.'); return; }

  S.busy.auth = true; renderAll();
  try {
    if (reg) {
      S.registering = true;
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      S.pendingProfile = { uid: cred.user.uid, name, nick };
      try { await sendEmailVerification(cred.user); } catch (e) { /* tekrar gönderme ekranından denenebilir */ }
      S.registering = false;
      await routeAfterLogin(cred.user);
    } else {
      const cred = await signInWithEmailAndPassword(auth, email, pass);
      await routeAfterLogin(cred.user);
    }
  } catch (e) {
    S.registering = false;
    setMsg('authMsg', authErr(e));
  }
  S.busy.auth = false; renderAll();
}

/* Doğrulama ekranı: "Doğruladım" düğmesi */
async function checkVerified() {
  if (!S.user) return;
  setMsg('verifyMsg', '');
  try {
    await reload(S.user);
  } catch (e) { /* çevrimdışı olabilir */ }
  if (S.user.emailVerified) {
    setMsg('verifyMsg', '');
    await routeAfterLogin(S.user);
  } else {
    setMsg('verifyMsg', 'Henüz doğrulanmamış görünüyor. Bağlantıya tıkladığından emin ol, sonra tekrar dene.');
  }
}

async function resendVerify() {
  if (!S.user) return;
  try {
    await sendEmailVerification(S.user);
    setMsg('verifyMsg', 'Doğrulama bağlantısı yeniden gönderildi.', true);
  } catch (e) {
    setMsg('verifyMsg', 'Çok sık denediğin için bağlantı şu an gönderilemedi. Biraz bekleyip tekrar dene.');
  }
}

/* Profil kurulum ekranı (eski hesaplar ve doğrulama sonrası) */
async function submitSetup(ev) {
  ev.preventDefault();
  if (!S.user || S.busy.setup) return;
  const name = $('setupName').value.trim();
  const nick = $('setupNick').value.trim().toLowerCase();
  setMsg('setupMsg', '');
  if (!name) { setMsg('setupMsg', 'Adını yaz.'); return; }
  if (!NICK_RE.test(nick)) { setMsg('setupMsg', 'Nickname 3-20 karakter olmalı: küçük harf, rakam ve alt çizgi.'); return; }
  S.busy.setup = true;
  try {
    await createProfile(S.user, name, nick);
    S.gate = 'app';
    await loadProfile(S.user);
    enterApp(S.user);
  } catch (e) {
    setMsg('setupMsg', 'Bu nickname alınmış olabilir ya da bağlantıda sorun var. Başka bir nickname dene.');
  }
  S.busy.setup = false; renderAll();
}

async function resetPassword() {
  const email = $('authEmail').value.trim();
  if (!email) { setMsg('authMsg', 'Önce e-posta adresini yaz.'); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    setMsg('authMsg', 'Şifre sıfırlama bağlantısı e-postana gönderildi (spam klasörüne de bak).', true);
  } catch (e) {
    setMsg('authMsg', authErr(e));
  }
}

async function deleteAccount() {
  setMsg('delMsg', '');
  const pass = $('delPass').value;
  if (!pass) { setMsg('delMsg', 'Şifreni yaz.'); return; }
  if (S.trips.length) {
    setMsg('delMsg', 'Önce tüm gezilerden ayrılmalı ya da sahibi olduğun gezileri silmelisin. Ayrılamıyorsan harcamalarını gezi sahibinden sildirmelisin.');
    return;
  }
  if (!confirmArm('delacct')) { setMsg('delMsg', 'Emin misin? Silmek için bir kez daha dokun.'); return; }
  try {
    const u = S.user;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, pass));
    await deleteDoc(doc(db, 'users', u.uid));
    if (S.myNick) { try { await deleteDoc(doc(db, 'usernames', S.myNick)); } catch (e) { /* yoksa sorun değil */ } }
    await deleteUser(u);
  } catch (e) {
    setMsg('delMsg', authErr(e));
  }
}

/* ---------- Gezi işlemleri ---------- */
async function findMember() {
  const t = curTrip();
  if (!t || t.ownerId !== myId() || S.busy.find) return;
  const nick = $('memberEmail').value.trim().toLowerCase().replace(/^@/, '');
  S.found = null; S.searchMsg = ''; setMsg('memberMsg', '');
  if (!NICK_RE.test(nick)) { S.searchMsg = 'Geçerli bir nickname yaz (3-20 karakter, küçük harf, rakam, alt çizgi).'; renderAll(); return; }
  if (nick === S.myNick) { S.searchMsg = 'Bu sensin, zaten gezidesin.'; renderAll(); return; }
  S.busy.find = true; renderAll();
  try {
    const un = await getDoc(doc(db, 'usernames', nick));
    if (!un.exists()) {
      S.searchMsg = 'Bu nickname ile kayıtlı kullanıcı yok. Arkadaşından nickname\'ini doğru yazmasını iste.';
    } else {
      const id = un.data().uid;
      if ((t.memberIds || []).indexOf(id) !== -1) {
        S.searchMsg = 'Bu kişi zaten gezide.';
      } else {
        const us = await getDoc(doc(db, 'users', id));
        S.names[id] = us.exists() ? pickUser(us.data()) : { name: '' };
        S.found = { id };
      }
    }
  } catch (e) {
    S.searchMsg = errText(e);
  }
  S.busy.find = false; renderAll();
}

function addMember(id) {
  const t = curTrip();
  if (!t || t.ownerId !== myId()) return;
  if ((t.memberIds || []).indexOf(id) !== -1) return;
  setMsg('memberMsg', '');
  updateDoc(doc(db, 'trips', t.id), { memberIds: arrayUnion(id) })
    .catch((e) => setMsg('memberMsg', errText(e)));
  S.found = null; S.searchMsg = ''; $('memberEmail').value = '';
  renderAll();
}

function removeMember(id, selfLeave) {
  const t = curTrip();
  if (!t) return;
  if (usedInExpenses(t, id)) {
    setMsg(selfLeave ? 'toolMsg' : 'memberMsg',
      selfLeave
        ? 'Harcamalarda geçtiğin için ayrılamazsın. Önce o harcamaların silinmesi gerekir.'
        : 'Bu kişi harcamalarda geçiyor. Önce o harcamaları sil.');
    return;
  }
  updateDoc(doc(db, 'trips', t.id), { memberIds: arrayRemove(id) })
    .catch((e) => setMsg(selfLeave ? 'createMsg' : 'memberMsg', errText(e)));
  if (selfLeave) { S.view = null; S.lastTrip = null; renderAll(); }
}

function deleteTrip() {
  const t = curTrip();
  if (!t || t.ownerId !== myId()) return;
  const refs = tripExps(t).map((e) => doc(db, 'trips', t.id, 'expenses', e.id));
  const batches = [];
  let b = writeBatch(db);
  let n = 0;
  refs.forEach((r) => {
    b.delete(r);
    if (++n >= 400) { batches.push(b); b = writeBatch(db); n = 0; }
  });
  b.delete(doc(db, 'trips', t.id));
  batches.push(b);
  S.view = null; S.lastTrip = null;
  renderAll();
  batches.reduce((p, x) => p.then(() => x.commit()), Promise.resolve())
    .catch((e) => setMsg('createMsg', 'Gezi silinemedi. ' + errText(e)));
}

/* ---------- Harcama işlemleri ---------- */
function saveExpense() {
  const t = curTrip();
  if (!t) return;
  setMsg('expMsg', '');
  const desc = $('desc').value.trim();
  const amount = parseAmount($('amount').value);
  const payer = $('payer').value;
  const among = Array.prototype.slice.call(document.querySelectorAll('#among input:checked')).map((i) => i.value);
  const members = t.memberIds || [];
  if (!S.editing && members.length < 2) { setMsg('expMsg', 'Önce geziye en az bir kişi daha ekle.'); return; }
  if (!desc) { setMsg('expMsg', 'Harcamanın ne için olduğunu yaz.'); return; }
  if (!isFinite(amount) || amount <= 0) { setMsg('expMsg', 'Geçerli bir tutar gir.'); return; }
  if (amount > 100000000000) { setMsg('expMsg', 'Tutar çok büyük.'); return; }
  if (members.indexOf(payer) === -1) { setMsg('expMsg', 'Ödeyen kişiyi seç.'); return; }
  if (!among.length) { setMsg('expMsg', 'Bölüşülecek en az bir kişi seç.'); return; }

  /* Fiş: undefined = dokunulmadı (düzenlemede aynen kalır), null = kaldırıldı, metin = yeni fiş */
  const receiptPart = S.pendingReceipt === undefined ? {} : { receipt: S.pendingReceipt };
  const p = S.editing
    ? updateDoc(doc(db, 'trips', t.id, 'expenses', S.editing),
      Object.assign({ desc, amount, payerId: payer, amongIds: among, updatedAt: Date.now() }, receiptPart))
    : addDoc(collection(db, 'trips', t.id, 'expenses'),
      { desc, amount, payerId: payer, amongIds: among, by: myId(), at: Date.now(), receipt: S.pendingReceipt || null });
  clearReceiptForm();
  p.catch((e) => setMsg('expMsg', errText(e)));

  /* Bir sonraki harcama için herkes yeniden seçili gelsin (yanlışlıkla eksik bölüşmeyi önler) */
  S.pendingForm = { payer: S.editing ? myId() : payer, among: members.slice() };
  S.editing = null;
  $('desc').value = ''; $('amount').value = ''; $('amtHint').textContent = '';
  $('desc').focus();
  renderAll();
}

/* Düzenlemeden sonra "kim ödedi / kimler arasında" seçimlerini varsayılana döndür */
function resetFormChoices(t) {
  S.pendingForm = { payer: myId(), among: (t.memberIds || []).slice() };
}

function startEdit(id) {
  const t = curTrip();
  if (!t) return;
  const e = tripExps(t).find((x) => x.id === id);
  if (!e) return;
  S.editing = id;
  clearReceiptForm();
  $('desc').value = e.desc;
  $('amount').value = (e.amount / 100).toFixed(2).replace('.', ',');
  S.pendingForm = { payer: e.payerId, among: (e.amongIds || []).slice() };
  setMsg('expMsg', '');
  updateAmtHint();
  renderAll();
  $('expenseForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEdit() {
  clearReceiptForm();
  const t = curTrip();
  if (t) resetFormChoices(t);
  S.editing = null;
  $('desc').value = ''; $('amount').value = ''; $('amtHint').textContent = '';
  setMsg('expMsg', '');
  renderAll();
}

function deleteExpense(eid) {
  const t = curTrip();
  if (!t) return;
  if (!confirmArm('exp:' + eid)) return;
  deleteDoc(doc(db, 'trips', t.id, 'expenses', eid)).catch((e) => setMsg('expMsg', errText(e)));
  if (S.editing === eid) cancelEdit();
}

function copySummary() {
  const t = curTrip();
  if (!t) return;
  const st = stats(t);
  const cur = t.currency || '₺';
  const lines = [t.name, 'Toplam harcama: ' + money(st.total, cur), '', 'Ödemeler:'];
  const sets = settlements(st.net);
  if (!sets.length) lines.push('Kimsenin borcu yok.');
  sets.forEach((s) => {
    lines.push((rawName(s.from) || 'Biri') + ' → ' + (rawName(s.to) || 'Biri') + ': ' + money(s.amount, cur));
  });
  const text = lines.join('\n');
  const btn = $('copyBtn');
  const done = () => { btn.textContent = 'Kopyalandı ✓'; setTimeout(() => { btn.textContent = 'Özeti kopyala'; }, 1500); };
  const fallback = () => { const o = $('copyOut'); o.style.display = 'block'; o.value = text; o.focus(); o.select(); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  } catch (e) { fallback(); }
}

/* ---------- Tema ---------- */
function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; }
}
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* kaydedilemezse sorun değil */ }
  renderAll();
}

/* ---------- Sayfa geçişleri ---------- */
function openPage(p) {
  S.page = p; S.view = null; S.lastTrip = null;
  if (p === 'profile') {
    const u = S.names[myId()] || {};
    $('acctName').value = u.name || '';
    $('ibanInput').value = u.iban || '';
    setMsg('acctMsg', ''); setMsg('photoMsg', ''); setMsg('ibanMsg', '');
  }
  if (p === 'new') { S.newMembers = []; S.newSuggestMsg = ''; setMsg('createMsg', ''); }
  renderAll();
  window.scrollTo(0, 0);
}

function goBack() {
  if (S.view) { S.view = null; S.lastTrip = null; }
  else S.page = 'list';
  renderAll();
  window.scrollTo(0, 0);
}

/* ---------- Fotoğraf: küçültüp metin olarak sakla (depolama gerektirmez) ---------- */
function resizeImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('img'));
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* Belgeye sığacak kadar küçült (Firestore belge sınırı 1 MB) */
async function shrinkTo(file, steps, limit) {
  for (let i = 0; i < steps.length; i++) {
    const url = await resizeImage(file, steps[i][0], steps[i][1]);
    if (url.length <= limit) return url;
  }
  return null;
}

/* ---------- Kopyalama ---------- */
function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = 'Kopyalandı ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => { window.prompt('IBAN', text); });
    } else {
      window.prompt('IBAN', text);
    }
  } catch (e) { window.prompt('IBAN', text); }
}

/* ---------- Yeni gezi: kişi ekleme ---------- */
async function lookupNick(nick) {
  const un = await getDoc(doc(db, 'usernames', nick));
  if (!un.exists()) return null;
  const id = un.data().uid;
  const us = await getDoc(doc(db, 'users', id));
  S.names[id] = us.exists() ? pickUser(us.data()) : { name: '' };
  return id;
}

async function addNewMember(nickRaw, fromSuggest) {
  const nick = String(nickRaw || '').trim().toLowerCase().replace(/^@/, '');
  S.newSuggestMsg = '';
  if (!fromSuggest && !NICK_RE.test(nick)) {
    S.newSuggestMsg = 'Geçerli bir nickname yaz (3-20 karakter, küçük harf, rakam, alt çizgi).';
    renderAll(); return;
  }
  if (!fromSuggest && nick === S.myNick) { S.newSuggestMsg = 'Sen zaten gezidesin.'; renderAll(); return; }
  try {
    const id = fromSuggest ? nickRaw : await lookupNick(nick);
    if (!id) { S.newSuggestMsg = 'Bu nickname ile kayıtlı kullanıcı yok.'; }
    else if (S.newMembers.indexOf(id) !== -1 || id === myId()) { S.newSuggestMsg = 'Bu kişi zaten listede.'; }
    else { S.newMembers.push(id); $('newMemberInput').value = ''; }
  } catch (e) {
    S.newSuggestMsg = errText(e);
  }
  renderAll();
}

/* ---------- Gezi oluştur (kişilerle birlikte) ---------- */
function createTrip() {
  setMsg('createMsg', '');
  const name = $('newTripName').value.trim();
  if (!name) { setMsg('createMsg', 'Gezinin adını yaz.'); return; }
  if (S.busy.create) return;
  const ref = doc(collection(db, 'trips'));
  const members = [myId()].concat(S.newMembers.filter((id) => id !== myId()));
  S.busy.create = true;
  setDoc(ref, {
    name, currency: $('newTripCur').value, ownerId: myId(), memberIds: members, at: Date.now()
  }).catch((e) => setMsg('createMsg', errText(e)));
  $('newTripName').value = '';
  S.newMembers = [];
  S.page = 'list';
  S.view = ref.id;
  setTimeout(() => { S.busy.create = false; renderAll(); }, 600);
  renderAll();
}

/* ---------- Profil kaydı: ad + IBAN ---------- */
async function saveProfileFields() {
  const name = $('acctName').value.trim();
  const ibanRaw = $('ibanInput').value.trim().replace(/\s+/g, '').toUpperCase();
  setMsg('acctMsg', ''); setMsg('ibanMsg', '');
  if (!name) { setMsg('acctMsg', 'Bir ad yaz.'); return; }
  if (ibanRaw && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(ibanRaw)) {
    setMsg('ibanMsg', 'IBAN geçersiz görünüyor. Ülke koduyla başlamalı (TR gibi), boşluklar sorun değil.');
    return;
  }
  const uid = myId();
  try {
    await updateDoc(doc(db, 'users', uid), { name, iban: ibanRaw || null, updatedAt: Date.now() });
    S.names[uid] = Object.assign({}, S.names[uid], { name, iban: ibanRaw || '' });
    setMsg('acctMsg', 'Kaydedildi.', true);
    renderAll();
  } catch (e) {
    setMsg('acctMsg', errText(e));
  }
}

async function setEmoji(e) {
  const uid = myId();
  try {
    await updateDoc(doc(db, 'users', uid), { emoji: e, photo: null, updatedAt: Date.now() });
    S.names[uid] = Object.assign({}, S.names[uid], { emoji: e, photo: null });
    setMsg('photoMsg', 'Profil simgesi değişti.', true);
    renderAll();
  } catch (err) { setMsg('photoMsg', errText(err)); }
}

async function onPhotoChosen(file) {
  if (!file) return;
  setMsg('photoMsg', 'Fotoğraf hazırlanıyor…', true);
  try {
    const url = await shrinkTo(file, [[256, 0.8], [200, 0.7], [160, 0.6]], 150000);
    if (!url) { setMsg('photoMsg', 'Fotoğraf çok büyük. Daha küçük bir fotoğraf seç.'); return; }
    const uid = myId();
    await updateDoc(doc(db, 'users', uid), { photo: url, updatedAt: Date.now() });
    S.names[uid] = Object.assign({}, S.names[uid], { photo: url });
    setMsg('photoMsg', 'Profil fotoğrafı kaydedildi.', true);
    renderAll();
  } catch (err) {
    setMsg('photoMsg', 'Fotoğraf okunamadı. Başka bir dosya dene.');
  }
}

async function clearPhoto() {
  const uid = myId();
  try {
    await updateDoc(doc(db, 'users', uid), { photo: null, updatedAt: Date.now() });
    S.names[uid] = Object.assign({}, S.names[uid], { photo: null });
    setMsg('photoMsg', 'Fotoğraf kaldırıldı.', true);
    renderAll();
  } catch (err) { setMsg('photoMsg', errText(err)); }
}

/* ---------- Fiş ---------- */
async function onReceiptChosen(file) {
  if (!file) return;
  setMsg('receiptMsg', 'Fiş hazırlanıyor…', true);
  try {
    const url = await shrinkTo(file, [[1000, 0.7], [700, 0.6], [500, 0.5]], 380000);
    if (!url) { setMsg('receiptMsg', 'Fiş fotoğrafı çok büyük. Daha yakın ve küçük bir fotoğraf dene.'); return; }
    S.pendingReceipt = url;
    $('receiptPrevImg').src = url;
    $('receiptPrev').hidden = false;
    $('receiptClear').hidden = false;
    setMsg('receiptMsg', 'Fiş eklendi. Harcamayı kaydedince birlikte saklanır.', true);
  } catch (err) {
    setMsg('receiptMsg', 'Fiş okunamadı. Başka bir dosya dene.');
  }
}

function clearReceiptForm() {
  S.pendingReceipt = undefined;
  $('receiptPrev').hidden = true;
  $('receiptClear').hidden = true;
  $('receiptInput').value = '';
  setMsg('receiptMsg', '');
}

function showReceipt(eid) {
  const t = curTrip();
  if (!t) return;
  const e = tripExps(t).find((x) => x.id === eid);
  if (!e || !e.receipt) return;
  $('receiptImg').src = e.receipt;
  $('receiptDlg').showModal();
}

/* ---------- Olaylar ---------- */
function bindEvents() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  $('authForm').addEventListener('submit', submitAuth);
  $('resetBtn').addEventListener('click', resetPassword);
  $('logoutBtn').addEventListener('click', () => { signOut(auth); });
  $('verifyDoneBtn').addEventListener('click', checkVerified);
  $('verifyResendBtn').addEventListener('click', resendVerify);
  $('verifyLogoutBtn').addEventListener('click', () => { signOut(auth); });
  $('setupForm').addEventListener('submit', submitSetup);
  $('saveNameBtn').addEventListener('click', saveProfileFields);
  $('delAcctBtn').addEventListener('click', deleteAccount);

  $('createTripBtn').addEventListener('click', createTrip);
  $('newTripName').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); createTrip(); } });
  $('addExpenseBtn').addEventListener('click', saveExpense);
  $('cancelEditBtn').addEventListener('click', cancelEdit);
  ['desc', 'amount'].forEach((id) => {
    $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveExpense(); } });
  });
  $('amount').addEventListener('input', updateAmtHint);
  $('backBtn').addEventListener('click', goBack);
  $('copyBtn').addEventListener('click', copySummary);

  $('tripList').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-open]');
    if (!b) return;
    S.view = b.getAttribute('data-open');
    renderAll();
    window.scrollTo(0, 0);
  });
  $('members').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-del-member]');
    if (b) removeMember(b.getAttribute('data-del-member'), false);
  });
  ['memberResults', 'memberSuggest'].forEach((box) => {
    $(box).addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-add-member]');
      if (b) addMember(b.getAttribute('data-add-member'));
    });
  });
  $('memberFindBtn').addEventListener('click', findMember);
  $('memberEmail').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); findMember(); } });
  $('expenses').addEventListener('click', (ev) => {
    const r = ev.target.closest('[data-receipt]');
    if (r) { showReceipt(r.getAttribute('data-receipt')); return; }
    const d = ev.target.closest('[data-del-exp]');
    if (d) { deleteExpense(d.getAttribute('data-del-exp')); return; }
    const e = ev.target.closest('[data-edit-exp]');
    if (e) startEdit(e.getAttribute('data-edit-exp'));
  });
  $('leaveBtn').addEventListener('click', () => { if (confirmArm('leave')) removeMember(myId(), true); });
  $('deleteTripBtn').addEventListener('click', () => { if (confirmArm('deltrip')) deleteTrip(); });

  $('fabNew').addEventListener('click', () => openPage('new'));
  $('profileBtn').addEventListener('click', () => openPage('profile'));
  $('refreshBtn').addEventListener('click', refreshData);
  $('newAddBtn').addEventListener('click', () => addNewMember($('newMemberInput').value, false));
  $('newMemberInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addNewMember($('newMemberInput').value, false); }
  });
  $('newMemberSuggest').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-add-new]');
    if (b) addNewMember(b.getAttribute('data-add-new'), true);
  });
  $('newMembers').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-rm-new]');
    if (b) { S.newMembers = S.newMembers.filter((i) => i !== b.getAttribute('data-rm-new')); renderAll(); }
  });
  $('themeSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-theme]');
    if (b) applyTheme(b.getAttribute('data-theme'));
  });
  $('emojiPick').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-emoji]');
    if (b) setEmoji(b.getAttribute('data-emoji'));
  });
  $('photoInput').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    onPhotoChosen(f);
  });
  $('photoClear').addEventListener('click', clearPhoto);
  $('receiptInput').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    onReceiptChosen(f);
  });
  $('receiptClear').addEventListener('click', () => {
    S.pendingReceipt = null;
    $('receiptPrev').hidden = true;
    $('receiptClear').hidden = true;
    setMsg('receiptMsg', 'Fiş kaldırılacak.', true);
  });
  $('receiptClose').addEventListener('click', () => $('receiptDlg').close());
  $('settle').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-copy-iban]');
    if (!b) return;
    const u = S.names[b.getAttribute('data-copy-iban')];
    if (u && u.iban) copyText(u.iban, b);
  });

  window.addEventListener('online', () => { S.online = true; renderAll(); });
  window.addEventListener('offline', () => { S.online = false; renderAll(); });

  /* Android geri tuşu */
  try {
    const p = CapApp.addListener('backButton', () => {
      if (S.user && (S.view || S.page !== 'list')) goBack();
      else if (!S.user && S.authMode === 'register') setAuthMode('login');
      else CapApp.exitApp();
    });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* tarayıcıda geri tuşu yok */ }

  /* Uygulama arka plandan dönünce verileri yenile */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshData();
  });
  try {
    const p = CapApp.addListener('appStateChange', (st) => { if (st && st.isActive) refreshData(); });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* tarayıcıda yok */ }

  /* Aşağı çekerek yenileme (sayfa en üstteyken) */
  let pullY = null;
  let pulled = false;
  document.addEventListener('touchstart', (ev) => {
    pullY = (window.scrollY <= 0 && ev.touches.length === 1) ? ev.touches[0].clientY : null;
    pulled = false;
  }, { passive: true });
  document.addEventListener('touchmove', (ev) => {
    if (pullY === null) return;
    if (ev.touches[0].clientY - pullY > 90) pulled = true;
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (pulled) refreshData();
    pullY = null; pulled = false;
  }, { passive: true });
}

/* ---------- Başlat ---------- */
{
  const saved = getTheme();
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
}
bindEvents();
renderAll();
onAuthStateChanged(auth, (user) => {
  if (S.registering) return;
  if (!user) { leaveApp(); return; }
  if (S.gate === 'app' && S.user && S.user.uid === user.uid) { S.user = user; renderAll(); return; }
  routeAfterLogin(user);
});
