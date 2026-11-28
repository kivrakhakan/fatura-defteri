'use strict';
/* Fatura Defteri: faturaları ve Z raporlarını aya göre saklar, ay sonunda PDF yapıp paylaşır.
   Her şey telefonda (IndexedDB) durur; internete hiçbir şey gönderilmez. */

const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const GUNLER = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
const TURLER = ['Kira','Elektrik','Su','Güvenlik alarmı'];
const DIGER = '__diger__';
const VERGI_TURLER = ['KDV', 'SGK primi', 'Muhtasar (stopaj)', 'Geçici vergi', 'Gelir / kurumlar vergisi', 'Bağ-Kur'];

const $ = s => document.querySelector(s);
const kacis = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sayiBicim = new Intl.NumberFormat('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2});
const para = n => sayiBicim.format(n) + ' TL';

function tutarOku(s) {
  s = String(s || '').trim().replace(/\s|TL|₺/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}
const ikiHane = n => String(n).padStart(2, '0');
const bugunStr = () => { const d = new Date(); return `${d.getFullYear()}-${ikiHane(d.getMonth()+1)}-${ikiHane(d.getDate())}`; };
const ayOf = tarihStr => tarihStr.slice(0, 7);
const ayEtiket = ay => `${AYLAR[+ay.slice(5,7)-1]} ${ay.slice(0,4)}`;
const ayKaydir = (ay, n) => { const d = new Date(+ay.slice(0,4), +ay.slice(5,7)-1+n, 1); return `${d.getFullYear()}-${ikiHane(d.getMonth()+1)}`; };
const ayGunSayisi = ay => new Date(+ay.slice(0,4), +ay.slice(5,7), 0).getDate();
function tarihYazi(t, gunAdi) {
  if (!t) return '';
  const d = new Date(+t.slice(0,4), +t.slice(5,7)-1, +t.slice(8,10));
  return `${d.getDate()} ${AYLAR[d.getMonth()]}` + (gunAdi ? ` ${GUNLER[d.getDay()]}` : ` ${d.getFullYear()}`);
}
const dosyaAdiTemiz = s => s.replace(/[çÇğĞıİöÖşŞüÜ]/g, c => ({ç:'c',Ç:'C',ğ:'g',Ğ:'G',ı:'i',İ:'I',ö:'o',Ö:'O',ş:'s',Ş:'S',ü:'u',Ü:'U'}[c])).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');

/* ---------- Veritabanı ---------- */
let db;
function dbAc() {
  return new Promise((ok, hata) => {
    const r = indexedDB.open('fatura-defteri', 2);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('kayit', {keyPath: 'id'}).createIndex('ay', 'ay');
        d.createObjectStore('ay', {keyPath: 'ay'});
      }
      // Sürüm 2: vergiler aydan bağımsız listelendiği için klasöre göre arama
      if (e.oldVersion < 2) r.transaction.objectStore('kayit').createIndex('klasor', 'klasor');
    };
    r.onsuccess = () => { db = r.result; ok(); };
    r.onerror = () => hata(r.error);
  });
}
function islem(depo, mod, fn) {
  return new Promise((ok, hata) => {
    const t = db.transaction(depo, mod);
    let sonuc;
    const r = fn(t.objectStore(depo));
    if (r) r.onsuccess = () => { sonuc = r.result; };
    t.oncomplete = () => ok(sonuc);
    t.onerror = t.onabort = () => hata(t.error || new Error('Kayıt hatası'));
  });
}
const kayitlariGetir = ay => islem('kayit', 'readonly', s => s.index('ay').getAll(ay));
/* Ödeme takip klasörleri: son ödeme tarihi + ödendi işareti olanlar */
const TAKIP = {
  vergi:  {sekme: 'Vergiler', ekle: '+ Vergi ekle', bos: 'Ödenecek vergi yok. Muhasebe vergi belgesi atınca buraya ekleyin, son ödeme gününü takip edelim.'},
  serkan: {sekme: 'Serkan', ekle: '+ Aylık ödeme ekle', bos: 'Aylık ödeme yok. Örneğin "Turkcell annem", tutarı ve son ödeme gününü yazın. Ödendi deyince bir sonraki ayın kaydı kendiliğinden açılır.'}
};
const takipMi = kl => kl in TAKIP;
const vergileriGetir = async () => {
  const sonuc = [];
  for (const kl of Object.keys(TAKIP)) sonuc.push(...await islem('kayit', 'readonly', s => s.index('klasor').getAll(kl)));
  return sonuc;
};
const kayitYaz = k => { const {_url, ...temiz} = k; return islem('kayit', 'readwrite', s => s.put(temiz)); };
const kayitSil = id => islem('kayit', 'readwrite', s => s.delete(id));
const ayBilgiGetir = ay => islem('ay', 'readonly', s => s.get(ay));
const ayBilgiYaz = b => islem('ay', 'readwrite', s => s.put(b));

/* ---------- Durum ---------- */
let ay = ayOf(bugunStr());
let sekme = 'fatura';
let kayitlar = [];
let vergiler = [];   // takip klasörlerinin (vergi + serkan) bütün kayıtları; ödenmeyen, ödenene kadar görünür
let ayBilgi = null;
const blobUrl = k => { if (!k._url) k._url = URL.createObjectURL(new Blob([k.veri], {type: k.tip})); return k._url; };

async function yenile() {
  kayitlar.concat(vergiler).forEach(k => k._url && URL.revokeObjectURL(k._url));
  kayitlar = await kayitlariGetir(ay);
  vergiler = await vergileriGetir();
  ayBilgi = await ayBilgiGetir(ay);
  ciz();
}

/* ---------- Vergiler: son ödeme durumu ---------- */
const gunFarki = t => {
  const b = new Date(); b.setHours(0, 0, 0, 0);
  const d = new Date(+t.slice(0,4), +t.slice(5,7)-1, +t.slice(8,10));
  return Math.round((d - b) / 86400000);
};
function vergiDurum(k) {
  if (k.odendi) { const d = new Date(k.odendi); return {yazi: `Ödendi, ${d.getDate()} ${AYLAR[d.getMonth()]}`, sinif: 'odendi'}; }
  const g = gunFarki(k.tarih);
  if (g < 0) return {yazi: `Son ödeme ${-g} gün geçti`, sinif: 'gecti'};
  if (g === 0) return {yazi: 'Bugün son gün', sinif: 'gecti'};
  if (g === 1) return {yazi: 'Yarın son gün', sinif: 'yakin'};
  if (g <= 3) return {yazi: `${g} gün kaldı`, sinif: 'yakin'};
  return {yazi: `${g} gün kaldı`, sinif: ''};
}
const odenecekler = kl => vergiler.filter(k => !k.odendi && (!kl || k.klasor === kl)).sort((a, b) => a.tarih.localeCompare(b.tarih));
const buAyOdenenler = kl => vergiler.filter(k => { if (!k.odendi || k.klasor !== kl) return false; const d = new Date(k.odendi); return `${d.getFullYear()}-${ikiHane(d.getMonth()+1)}` === ay; }).sort((a, b) => b.odendi - a.odendi);
async function odendiDegistir(id) {
  const k = vergiler.find(x => x.id === id);
  if (!k) return;
  if (k.odendi) {
    if (!confirm(`${k.tur} "ödenmedi" olarak geri alınsın mı?`)) return;
    // Ödendi denince açılan sonraki ay kaydı henüz ödenmediyse onu da kaldır (çift kayıt olmasın)
    const sonraki = k.sonrakiId && vergiler.find(x => x.id === k.sonrakiId);
    if (sonraki && !sonraki.odendi) await kayitSil(sonraki.id);
    await kayitYaz({...k, odendi: null, sonrakiId: null});
  } else {
    let sonrakiId = null;
    if (k.klasor === 'serkan') {   // Serkan klasörü aylık: ödenince gelecek ayın kaydı açılır
      const odemeGunu = k.odemeGunu || +k.tarih.slice(8, 10);
      const tarih = birAySonra(k.tarih, odemeGunu);
      sonrakiId = yeniId();
      await kayitYaz({...k, id: sonrakiId, ay: ayOf(tarih), tarih, odemeGunu, odendi: null, sonrakiId: null, eklendi: Date.now()});
    }
    await kayitYaz({...k, odendi: Date.now(), sonrakiId});
  }
  await yenile();
  return true;
}
const yeniId = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random();
/* Bir sonraki ayın aynı günü; ayda o gün yoksa ayın son günü (31 → 30/28) */
function birAySonra(t, gun) {
  const sonrakiAy = ayKaydir(ayOf(t), 1);
  return `${sonrakiAy}-${ikiHane(Math.min(gun, ayGunSayisi(sonrakiAy)))}`;
}

/* Uyarı: son günü 3 gün ya da daha az kalan (veya geçen) ödenmemiş vergiler.
   Takvim KULLANILMIYOR (kullanıcı isteği: arkada silinmeyen kayıt kalmasın). */
const acilVergiler = () => odenecekler().filter(k => gunFarki(k.tarih) <= 3);
const rozetDestekli = () => 'setAppBadge' in navigator && 'Notification' in window;
function rozetGuncelle() {
  if (!rozetDestekli() || Notification.permission !== 'granted') return;
  const n = acilVergiler().length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
async function rozetIzniIste() {
  try { await Notification.requestPermission(); } catch (e) {}
  ciz();
}

function vergiUyarisi() {
  rozetGuncelle();
  const acil = acilVergiler();
  const yer = $('#vergiUyari');
  if (!acil.length) { yer.innerHTML = ''; return; }
  const satir = acil.map(k => `<b>${kacis(k.tur)}</b>: ${vergiDurum(k).yazi.toLowerCase()}`).join('<br>');
  const hedef = acil[0].klasor;
  yer.innerHTML = `<button class="uyari" data-sekme="${hedef}">${satir}<span>${TAKIP[hedef].sekme} klasörünü aç</span></button>`;
}

const faturalar = () => kayitlar.filter(k => k.klasor === 'fatura').sort((a, b) => a.eklendi - b.eklendi);
const zler = () => kayitlar.filter(k => k.klasor === 'z').sort((a, b) => a.tarih.localeCompare(b.tarih) || a.eklendi - b.eklendi);
const topla = liste => liste.reduce((t, k) => t + (k.tutar || 0), 0);
/* "Bu ay gelmedi" işaretlenen fatura türleri (ay kaydında saklanır) */
const gelmediler = () => (ayBilgi && ayBilgi.gelmedi) || [];
const eksikTurler = f => TURLER.filter(t => !f.some(k => k.tur === t) && !gelmediler().includes(t));
async function gelmediDegistir(tur, isaretle) {
  const liste = gelmediler().filter(t => t !== tur);
  if (isaretle) liste.push(tur);
  await ayBilgiYaz({...(ayBilgi || {}), ay, gelmedi: liste});
  await yenile();
}

function ciz() {
  const f = faturalar(), z = zler();
  $('#ayAdi').firstChild.textContent = ayEtiket(ay);
  const durum = $('#ayDurum');
  if (ayBilgi && ayBilgi.gonderildi) {
    const d = new Date(ayBilgi.gonderildi);
    durum.textContent = `Muhasebeye gönderildi, ${d.getDate()} ${AYLAR[d.getMonth()]} ${ikiHane(d.getHours())}:${ikiHane(d.getMinutes())}`;
    durum.className = 'durum tamam';
  } else { durum.textContent = 'Henüz gönderilmedi'; durum.className = 'durum'; }
  $('#ileri').disabled = ay >= ayOf(bugunStr());

  const girilen = TURLER.filter(t => f.some(k => k.tur === t) || gelmediler().includes(t)).length;
  $('#sayF').textContent = `${girilen}/${TURLER.length}`;
  $('#sayZ').textContent = z.length ? String(z.length) : '';
  for (const [kl, id] of [['vergi', '#sayV'], ['serkan', '#sayS']]) {
    const od = odenecekler(kl);
    $(id).textContent = od.length ? String(od.length) : '';
    $(id).classList.toggle('acil', od.some(k => gunFarki(k.tarih) <= 3));
  }
  $('#sekmeF').setAttribute('aria-selected', sekme === 'fatura');
  $('#sekmeZ').setAttribute('aria-selected', sekme === 'z');
  $('#sekmeV').setAttribute('aria-selected', sekme === 'vergi');
  $('#sekmeS').setAttribute('aria-selected', sekme === 'serkan');
  vergiUyarisi();

  const kl = $('#klasor');
  kl.className = 'klasor ' + ({fatura: 'f', z: 'z', vergi: 'v', serkan: 's'})[sekme];
  kl.innerHTML = sekme === 'fatura' ? faturaHtml(f) : sekme === 'z' ? zHtml(z) : vergiHtml(sekme);

  const parca = [];
  if (f.length) parca.push(`${f.length} fatura`);
  if (z.length) parca.push(`${z.length} Z raporu`);
  $('#ozet').textContent = parca.length ? parca.join(', ') + ' gönderilecek' : 'Bu ay henüz bir şey eklenmedi';
  $('#gonderBtn').disabled = !(f.length || z.length);
}

function vergiHtml(kl) {
  const od = odenecekler(kl), bilgi = TAKIP[kl];
  const satir = k => {
    const d = vergiDurum(k);
    return `<div class="vsatir">
      <button class="tik${k.odendi ? ' var' : ''}" data-ode="${k.id}" aria-label="${kacis(k.tur)}: ${k.odendi ? 'ödenmedi yap' : 'ödendi olarak işaretle'}"></button>
      <button class="vbilgi" data-gor="${k.id}">
        <b>${kacis(k.tur)}</b>
        <small>${k.klasor === 'serkan' ? 'Aylık, son ödeme' : 'Son ödeme'}: ${tarihYazi(k.tarih, true)}</small>
        <small class="vdurum ${d.sinif}">${d.yazi}</small>
      </button>
      <span class="tutar">${k.tutar != null ? para(k.tutar) : ''}</span></div>`;
  };
  let h = `<button class="zbuyuk" data-ekle="${kl}">${bilgi.ekle}</button>`;
  if (rozetDestekli() && Notification.permission === 'default')
    h += `<button class="rozetizin" data-rozet>Son günü yaklaşan ödemelerin sayısı uygulama simgesinde görünsün. Açmak için dokunun.</button>`;
  if (od.length) h += `<h3 class="ara">Ödenecekler</h3>` + od.map(satir).join('') +
    `<div class="alt"><span>Ödenecek toplam</span><b>${para(topla(od))}</b></div>`;
  else h += `<p class="bos">${bilgi.bos}</p>`;
  const odenen = buAyOdenenler(kl);
  if (odenen.length) h += `<h3 class="ara">${AYLAR[+ay.slice(5,7)-1]} ayında ödenenler</h3>` + odenen.map(satir).join('');
  return h;
}

/* Gider türüne göre simge: [renk, svg çizgileri]. Ada göre eşleşir, bulunamazsa fiş simgesi. */
const SIMGELER = [
  [/kira/i,                    '#5F74DB', '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.67 2.67 0 005.33 0 2.67 2.67 0 005.34 0 2.67 2.67 0 005.33 0"/><path d="M5 11.5V20h14v-8.5"/><path d="M10 20v-5h4v5"/>'],
  [/elektrik/i,                '#C08400', '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>'],
  [/^su\b|su fatura/i,         '#1E82C4', '<path d="M12 3c-4 5-6 8-6 11a6 6 0 0012 0c0-3-2-6-6-11z"/>'],
  [/alarm|güvenlik/i,          '#C0392B', '<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21a2 2 0 004 0"/>'],
  [/doğalgaz|dogalgaz|gaz/i,   '#D2601A', '<path d="M12 3c1 4 5 6 5 11a5 5 0 01-10 0c0-3 2-4 2-7 2 1 3 3 3 3"/>'],
  [/internet|wifi/i,           '#24907F', '<path d="M2 9a15 15 0 0120 0"/><path d="M5 12.5a10 10 0 0114 0"/><path d="M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1"/>'],
  [/telefon|turkcell|vodafone|türk telekom|gsm/i, '#7652B3', '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'],
];
const VARSAYILAN_SIMGE = ['#5A6675', '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'];
function simge(tur) {
  const s = SIMGELER.find(([re]) => re.test(tur || ''));
  const [renk, cizgi] = s ? [s[1], s[2]] : VARSAYILAN_SIMGE;
  return {renk, svg: `<svg viewBox="0 0 24 24" aria-hidden="true">${cizgi}</svg>`};
}

function kucukResim(k) {
  if (k.tip !== 'application/pdf') return `<img class="kucuk" src="${k.kucuk}" alt="">`;
  const s = simge(k.klasor === 'z' ? '' : k.tur);
  return `<span class="kucuk ikonlu" style="--ic:${s.renk}">${s.svg}</span>`;
}

function faturaHtml(f) {
  const adlar = [...TURLER];
  f.forEach(k => { if (!adlar.includes(k.tur)) adlar.push(k.tur); });
  let h = '';
  for (const ad of adlar) {
    const liste = f.filter(k => k.tur === ad);
    const gelmedi = !liste.length && gelmediler().includes(ad);
    const alt = liste.length
      ? `<small>${liste.length > 1 ? liste.length + ' fatura, ' : ''}${para(topla(liste))}</small>`
      : gelmedi ? `<small>Bu ay gelmedi</small>` : `<small class="eksik">Bu ay girilmedi</small>`;
    const dugmeler = gelmedi
      ? `<button class="ekle ikincil" data-gelmedi-geri="${kacis(ad)}">Geri al</button>`
      : (!liste.length ? `<button class="ekle ikincil" data-gelmedi="${kacis(ad)}">Gelmedi</button>` : '') +
        `<button class="ekle" data-ekle="${kacis(ad)}" aria-label="${kacis(ad)} faturası ekle">${liste.length ? '+ Bir tane daha' : '+ Ekle'}</button>`;
    const s = simge(ad);
    h += `<div class="satir"><span class="ikon${liste.length ? ' var' : gelmedi ? ' yok' : ''}" style="--ic:${s.renk}">${s.svg}</span>
      <div class="ad"><b>${kacis(ad)}</b>${alt}</div>${dugmeler}</div>`;
    if (liste.length) {
      h += '<div class="kartlar">' + liste.map(k =>
        `<button class="kart" data-gor="${k.id}">${kucukResim(k)}<span>${k.tutar != null ? para(k.tutar) : 'Tutar yok'}<br><small>${tarihYazi(k.tarih)}</small></span></button>`
      ).join('') + '</div>';
    }
  }
  h += `<button class="diger" data-ekle="${DIGER}">+ Başka bir fatura ekle (doğalgaz, internet…)</button>`;
  h += `<div class="alt"><span>Faturalar toplamı</span><b>${para(topla(f))}</b></div>`;
  return h;
}

function zHtml(z) {
  let h = `<button class="zbuyuk" data-ekle="Z raporu">+ Z raporu ekle</button>`;
  if (!z.length) return h + `<p class="bos">Gün sonunda Z raporunun fotoğrafını çekin. Hepsi burada tarih sırasıyla durur.</p>`;
  h += z.map(k => `<button class="zsatir" data-gor="${k.id}">
      ${k.tip === 'application/pdf' ? kucukResim(k) : `<img class="fis" src="${k.kucuk}" alt="">`}
      <span class="ad"><b>${tarihYazi(k.tarih, true)}</b>${k.not ? `<small>${kacis(k.not)}</small>` : ''}</span>
      <span class="tutar">${k.tutar != null ? para(k.tutar) : ''}</span></button>`).join('');
  h += `<div class="alt"><span>${z.length} Z raporu toplamı</span><b>${para(topla(z))}</b></div>`;
  return h;
}

/* ---------- Resim küçültme ---------- */
function resimAc(blob) {
  return new Promise((ok, hata) => {
    const url = URL.createObjectURL(blob);
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); ok(i); };
    i.onerror = () => { URL.revokeObjectURL(url); hata(new Error('Bu resim açılamadı. Başka bir fotoğraf deneyin.')); };
    i.src = url;
  });
}
function tuvaleCiz(img, enBuyuk) {
  const o = Math.min(1, enBuyuk / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * o));
  c.height = Math.max(1, Math.round(img.naturalHeight * o));
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
const tuvalBlob = (c, q) => new Promise(ok => c.toBlob(ok, 'image/jpeg', q));

/* ---------- Ekleme penceresi ---------- */
let secilen = null; // {veri:ArrayBuffer, tip, ad, kucuk}
let ekleKlasor = 'fatura';

let duzenlenen = null;   // düzenlenen kayıt (yeni eklemede null)

/* Var olan kaydı ekleme formunda doldurup açar */
function duzenleAc(k) {
  $('#gorP').close();
  ekleAc(k.klasor === 'z' ? 'Z raporu' : takipMi(k.klasor) ? k.klasor : k.tur);
  duzenlenen = k;
  $('#ekleBaslik').textContent = 'Düzenle';
  $('#kaydet').textContent = 'Değişiklikleri kaydet';
  const sec = $('#tur');
  if (k.klasor !== 'z') {
    if ([...sec.options].some(o => o.value === k.tur)) sec.value = k.tur;
    else { sec.value = DIGER; $('#digerAd').value = k.tur; }
    $('#digerAlan').hidden = sec.value !== DIGER;
  }
  $('#tutar').value = k.tutar != null ? sayiBicim.format(k.tutar) : '';
  $('#tarih').value = k.tarih;
  $('#notAlan').value = k.not || '';
  if (k.veri) {
    secilen = {veri: k.veri, tip: k.tip, ad: k.ad, kucuk: k.kucuk};
    const on = $('#onizleme');
    on.hidden = false; on.style.flexDirection = k.tip === 'application/pdf' ? '' : 'column';
    on.innerHTML = (k.tip === 'application/pdf' ? `<div class="pdfad" style="flex:1">📄 ${kacis(k.ad || 'PDF')}</div>` : `<img src="${blobUrl(k)}" alt="Kayıtlı fotoğraf">`) +
      '<button type="button" data-degistir>Fotoğrafı ya da dosyayı değiştir</button>';
    $('#secim').hidden = true;
  }
}

function ekleAc(tur) {
  duzenlenen = null;
  $('#kaydet').textContent = 'Kaydet';
  ekleKlasor = tur === 'Z raporu' ? 'z' : takipMi(tur) ? tur : 'fatura';
  const vergi = ekleKlasor === 'vergi', serkan = ekleKlasor === 'serkan';
  secilen = null;
  $('#ekleForm').reset();
  $('#onizleme').hidden = true; $('#onizleme').innerHTML = '';
  $('#secim').hidden = serkan;   // Serkan klasörü belge istemez, sadece yazı
  $('#ekleHata').textContent = '';
  $('#ekleBaslik').textContent = {z: 'Z raporu ekle', vergi: 'Vergi ekle', serkan: 'Ödeme ekle', fatura: 'Fatura ekle'}[ekleKlasor];
  $('#turAlan').hidden = ekleKlasor === 'z' || serkan;
  $('#turEtiket').textContent = vergi ? 'Ne vergisi?' : 'Ne faturası?';
  $('#digerEtiket').textContent = serkan ? 'Ne ödemesi?' : vergi ? 'Verginin adı' : 'Faturanın adı';
  $('#digerAd').placeholder = serkan ? 'Örneğin: Turkcell annem' : vergi ? 'Örneğin: Emlak vergisi, ÇTV' : 'Örneğin: Doğalgaz, İnternet';
  $('#tarihEtiket').textContent = takipMi(ekleKlasor) ? 'Son ödeme tarihi' : {z: 'Rapor günü', fatura: 'Fatura tarihi'}[ekleKlasor];

  const sec = $('#tur');
  const adlar = vergi ? [...VERGI_TURLER] : [...TURLER];
  (vergi ? vergiler.filter(k => k.klasor === 'vergi') : faturalar()).forEach(k => { if (!adlar.includes(k.tur)) adlar.push(k.tur); });
  sec.innerHTML = adlar.map(a => `<option>${kacis(a)}</option>`).join('') + `<option value="${DIGER}">Diğer…</option>`;
  sec.value = serkan ? DIGER : ekleKlasor === 'fatura' ? (tur === DIGER ? DIGER : tur) : adlar[0];
  $('#digerAlan').hidden = sec.value !== DIGER;

  const tarih = $('#tarih');
  if (takipMi(ekleKlasor)) {
    tarih.min = ''; tarih.max = ''; tarih.value = '';
  } else {
    tarih.min = `${ay}-01`; tarih.max = `${ay}-${ikiHane(ayGunSayisi(ay))}`;
    const bugun = bugunStr();
    tarih.value = ayOf(bugun) === ay ? bugun : tarih.max;
  }
  $('#ekleP').showModal();
}

async function dosyaGeldi(file) {
  if (!file) return;
  const hataP = $('#ekleHata'); hataP.textContent = '';
  const on = $('#onizleme');
  on.hidden = false; on.innerHTML = '<div class="pdfad">Hazırlanıyor…</div>';
  try {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      if (file.size > 15 * 1024 * 1024) throw new Error('Bu PDF çok büyük (15 MB üstü).');
      secilen = {veri: await file.arrayBuffer(), tip: 'application/pdf', ad: file.name, kucuk: null};
      on.innerHTML = `<div class="pdfad" style="flex:1">📄 ${kacis(file.name)}</div><button type="button" data-degistir>Değiştir</button>`;
    } else {
      const img = await resimAc(file);
      const buyuk = await tuvalBlob(tuvaleCiz(img, 2000), 0.82);
      const kucuk = tuvaleCiz(img, 160).toDataURL('image/jpeg', 0.7);
      secilen = {veri: await buyuk.arrayBuffer(), tip: 'image/jpeg', ad: 'foto.jpg', kucuk};
      const url = URL.createObjectURL(buyuk);
      on.innerHTML = `<img src="${url}" alt="Seçilen fotoğraf">`;
      on.style.flexDirection = 'column';
      on.insertAdjacentHTML('beforeend', '<button type="button" data-degistir>Başka fotoğraf seç</button>');
    }
    $('#secim').hidden = true;
  } catch (e) {
    secilen = null; on.hidden = true; hataP.textContent = e.message;
  }
}

async function kaydet(e) {
  e.preventDefault();
  const hataP = $('#ekleHata');
  if (!secilen && ekleKlasor !== 'serkan') { hataP.textContent = 'Önce fotoğraf çekin ya da bir dosya seçin.'; return; }
  let tur = 'Z raporu';
  if (ekleKlasor !== 'z') {
    tur = $('#tur').value;
    if (tur === DIGER) {
      tur = $('#digerAd').value.trim();
      if (!tur) { hataP.textContent = {vergi: 'Verginin adını yazın.', serkan: 'Ne ödemesi olduğunu yazın.'}[ekleKlasor] || 'Faturanın adını yazın.'; $('#digerAd').focus(); return; }
    }
  }
  const tutar = tutarOku($('#tutar').value);
  if (Number.isNaN(tutar)) { hataP.textContent = 'Tutarı yalnızca rakamla yazın, örneğin 1.250,40'; $('#tutar').focus(); return; }
  if (takipMi(ekleKlasor) && !$('#tarih').value) { hataP.textContent = 'Son ödeme tarihini seçin.'; $('#tarih').focus(); return; }
  const tarih = $('#tarih').value || `${ay}-01`;
  const dosya = {veri: secilen ? secilen.veri : null, tip: secilen ? secilen.tip : null, ad: secilen ? secilen.ad : null, kucuk: secilen ? secilen.kucuk : null};
  const k = duzenlenen
    // Düzenleme: kimlik, ay, ödendi bilgisi aynı kalır; aylık ödemenin günü yeni tarihe göre güncellenir
    ? {...duzenlenen, tur, tutar, tarih, not: $('#notAlan').value.trim(), ...dosya,
       odemeGunu: duzenlenen.klasor === 'serkan' ? +tarih.slice(8, 10) : duzenlenen.odemeGunu}
    : {id: yeniId(), ay, klasor: ekleKlasor, tur, tutar, tarih, not: $('#notAlan').value.trim(), ...dosya, eklendi: Date.now(), odendi: null};
  $('#kaydet').disabled = true;
  try {
    await kayitYaz(k);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    $('#ekleP').close();
    await yenile();
  } catch (err) {
    hataP.textContent = 'Kaydedilemedi: telefonda yer kalmamış olabilir.';
  } finally { $('#kaydet').disabled = false; }
}

/* ---------- Görüntüleme ---------- */
let gorulen = null;
function gorAc(id) {
  const k = kayitlar.find(x => x.id === id) || vergiler.find(x => x.id === id);
  if (!k) return;
  gorulen = k;
  const vergi = takipMi(k.klasor);
  $('#gorBaslik').textContent = k.klasor === 'z' ? 'Z raporu' : k.tur;
  $('#gorIcerik').innerHTML = !k.veri ? '' : k.tip === 'application/pdf'
    ? `<p><a class="ekle" href="${blobUrl(k)}" target="_blank" rel="noopener">Belgeyi aç</a></p>`
    : `<img src="${blobUrl(k)}" alt="">`;
  $('#gorBilgi').innerHTML =
    `<dt>Tutar</dt><dd>${k.tutar != null ? para(k.tutar) : 'Girilmedi'}</dd>` +
    `<dt>${vergi ? 'Son ödeme' : 'Tarih'}</dt><dd>${tarihYazi(k.tarih)}</dd>` +
    (vergi ? `<dt>Durum</dt><dd class="vdurum ${vergiDurum(k).sinif}">${vergiDurum(k).yazi}</dd>` : '') +
    (k.klasor === 'serkan' ? `<dt>Tekrar</dt><dd>Her ay. Artık ödenmeyecekse bu kaydı silin.</dd>` : '') +
    (k.not ? `<dt>Not</dt><dd>${kacis(k.not)}</dd>` : '');
  const vd = $('#vergiDugmeler');
  vd.hidden = !vergi;
  if (vergi) {
    vd.innerHTML = `<button class="ana genis${k.odendi ? ' gri' : ''}" data-ode="${k.id}">${k.odendi ? 'Ödenmedi olarak geri al' : 'Ödendi olarak işaretle'}</button>`;
  }
  $('#gorP').showModal();
}
async function sil() {
  if (!gorulen) return;
  if (!confirm('Bu kayıt telefondan silinecek. Geri alınamaz. Silinsin mi?')) return;
  await kayitSil(gorulen.id);
  $('#gorP').close();
  await yenile();
}

/* ---------- PDF ---------- */
const SW = 1240, SH = 1754, KENAR = 90; // A4, 150 dpi

function yeniSayfa() {
  const c = document.createElement('canvas'); c.width = SW; c.height = SH;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, SW, SH);
  x.fillStyle = '#16202B'; x.textBaseline = 'alphabetic';
  return [c, x];
}
const yazi = (x, boyut, kalin) => { x.font = `${kalin ? '700' : '400'} ${boyut}px -apple-system, "Helvetica Neue", Arial, sans-serif`; };
function kisalt(x, s, gen) {
  if (x.measureText(s).width <= gen) return s;
  while (s.length && x.measureText(s + '…').width > gen) s = s.slice(0, -1);
  return s + '…';
}

function pdfBaslat() { return new window.jspdf.jsPDF({unit: 'mm', format: 'a4', compress: true}); }
function sayfaEkle(pdf, c, ilk) {
  if (!ilk) pdf.addPage();
  pdf.addImage(c.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, 210, 297);
}

/* Özet sayfası: tablo, gerekirse birden çok sayfa */
/* Muhasebeye giden PDF'te tutar ve toplam YOK (kullanıcı isteği): muhasebe tutarı belgeden kendisi okur. */
function ozetSayfalari(baslik, altBaslik, sutunlar, satirlar, dipnotlar) {
  const sayfalar = [];
  let [c, x] = yeniSayfa();
  let y = KENAR + 20;
  yazi(x, 46, true); x.fillText(baslik, KENAR, y); y += 46;
  yazi(x, 24); x.fillStyle = '#5A6675'; x.fillText(altBaslik, KENAR, y); x.fillStyle = '#16202B'; y += 60;
  const basligiCiz = () => {
    yazi(x, 22, true); x.fillStyle = '#5A6675';
    sutunlar.forEach(s => { x.textAlign = s.sag ? 'right' : 'left'; x.fillText(s.ad, s.sag ? s.x + s.g : s.x, y); });
    x.textAlign = 'left'; x.fillStyle = '#16202B';
    y += 16; x.fillRect(KENAR, y, SW - 2 * KENAR, 2); y += 44;
  };
  basligiCiz();
  for (const r of satirlar) {
    if (y > SH - KENAR - 160) { sayfalar.push(c); [c, x] = yeniSayfa(); y = KENAR + 20; basligiCiz(); }
    yazi(x, 26, false);
    sutunlar.forEach((s, i) => {
      x.fillStyle = r.renk && i === r.renkSutun ? r.renk : '#16202B';
      x.textAlign = s.sag ? 'right' : 'left';
      x.fillText(kisalt(x, r.h[i] || '', s.g), s.sag ? s.x + s.g : s.x, y);
    });
    x.textAlign = 'left'; x.fillStyle = '#E1E6EB'; x.fillRect(KENAR, y + 18, SW - 2 * KENAR, 1); x.fillStyle = '#16202B';
    y += 54;
  }
  y += 40;
  yazi(x, 22); x.fillStyle = '#5A6675';
  for (const d of dipnotlar) { x.fillText(kisalt(x, d, SW - 2 * KENAR), KENAR, y); y += 34; }
  sayfalar.push(c);
  return sayfalar;
}

async function fotoSayfasi(k, baslik) {
  const [c, x] = yeniSayfa();
  yazi(x, 30, true);
  x.fillText(kisalt(x, baslik, SW - 2 * KENAR), KENAR, KENAR);
  yazi(x, 24); x.fillStyle = '#5A6675';
  const alt = [tarihYazi(k.tarih), k.not || null].filter(Boolean).join('   ');
  x.fillText(kisalt(x, alt, SW - 2 * KENAR), KENAR, KENAR + 40);
  const img = await resimAc(new Blob([k.veri], {type: k.tip}));
  const ust = KENAR + 70, gen = SW - 2 * KENAR, yuk = SH - ust - KENAR;
  const o = Math.min(gen / img.naturalWidth, yuk / img.naturalHeight);
  const w = img.naturalWidth * o, h = img.naturalHeight * o;
  x.drawImage(img, KENAR + (gen - w) / 2, ust, w, h);
  return c;
}

async function dosyalariHazirla() {
  const f = faturalar(), z = zler();
  const etiket = ayEtiket(ay);
  const onEk = dosyaAdiTemiz(etiket);
  const dosyalar = [];
  const bugun = tarihYazi(bugunStr());

  if (f.length) {
    const pdf = pdfBaslat();
    const pdfDosyalar = f.filter(k => k.tip === 'application/pdf');
    const satirlar = f.map(k => ({h: [k.tur, tarihYazi(k.tarih), k.not || '']}));
    eksikTurler(f).forEach(t => satirlar.push({h: [t, '', 'Bu ay girilmedi'], renk: '#B3261E', renkSutun: 2}));
    gelmediler().filter(t => !f.some(k => k.tur === t)).forEach(t => satirlar.push({h: [t, '', 'Bu ay gelmedi'], renk: '#5A6675', renkSutun: 2}));
    const sutunlar = [{ad: 'Fatura', x: KENAR, g: 330}, {ad: 'Tarih', x: KENAR + 350, g: 260}, {ad: 'Not', x: KENAR + 630, g: SW - 2 * KENAR - 630}];
    const dip = [`${f.length} fatura. Hazırlanma tarihi: ${bugun}.`];
    if (pdfDosyalar.length) dip.push(`PDF olarak gelen ${pdfDosyalar.length} fatura ayrı dosya olarak eklendi.`);
    const ozet = ozetSayfalari(`${etiket} faturaları`, 'Aylık gider faturaları', sutunlar, satirlar, dip);
    ozet.forEach((c, i) => sayfaEkle(pdf, c, i === 0));
    for (const k of f) if (k.tip !== 'application/pdf') sayfaEkle(pdf, await fotoSayfasi(k, `${k.tur} faturası`), false);
    dosyalar.push(new File([pdf.output('blob')], `${onEk}-Faturalar.pdf`, {type: 'application/pdf'}));
    pdfDosyalar.forEach((k, i) => dosyalar.push(new File([k.veri], `${onEk}-${dosyaAdiTemiz(k.tur)}${pdfDosyalar.length > 1 ? '-' + (i + 1) : ''}.pdf`, {type: 'application/pdf'})));
  }

  if (z.length) {
    const pdf = pdfBaslat();
    const pdfDosyalar = z.filter(k => k.tip === 'application/pdf');
    const satirlar = z.map(k => ({h: [tarihYazi(k.tarih, true), k.not || '']}));
    const sutunlar = [{ad: 'Gün', x: KENAR, g: 420}, {ad: 'Not', x: KENAR + 440, g: SW - 2 * KENAR - 440}];
    const dip = [`${z.length} Z raporu. Hazırlanma tarihi: ${bugun}.`];
    if (pdfDosyalar.length) dip.push(`PDF olarak gelen ${pdfDosyalar.length} Z raporu ayrı dosya olarak eklendi.`);
    const ozet = ozetSayfalari(`${etiket} Z raporları`, 'Günlük kasa raporları', sutunlar, satirlar, dip);
    ozet.forEach((c, i) => sayfaEkle(pdf, c, i === 0));
    for (const k of z) if (k.tip !== 'application/pdf') sayfaEkle(pdf, await fotoSayfasi(k, `Z raporu, ${tarihYazi(k.tarih, true)}`), false);
    dosyalar.push(new File([pdf.output('blob')], `${onEk}-Z-Raporlari.pdf`, {type: 'application/pdf'}));
    pdfDosyalar.forEach(k => dosyalar.push(new File([k.veri], `${onEk}-Z-Raporu-${k.tarih}.pdf`, {type: 'application/pdf'})));
  }
  return dosyalar;
}

const boyutYazi = b => b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
let hazirDosyalar = [], hazirUrller = [];

async function gonderAc() {
  const ic = $('#gonderIcerik');
  $('#gonderBaslik').textContent = `${ayEtiket(ay)} gönderimi`;
  const f = faturalar();
  const eksik = eksikTurler(f);
  ic.innerHTML = '<p class="yukleniyor">Dosyalar hazırlanıyor…</p>';
  $('#gonderP').showModal();
  try {
    hazirDosyalar = await dosyalariHazirla();
  } catch (e) {
    ic.innerHTML = `<p class="hata">Dosyalar hazırlanamadı: ${kacis(e.message)}</p>`;
    return;
  }
  hazirUrller.forEach(u => URL.revokeObjectURL(u));
  const urller = hazirUrller = hazirDosyalar.map(d => URL.createObjectURL(d));
  const paylasilir = !!(navigator.canShare && navigator.canShare({files: hazirDosyalar}));
  ic.innerHTML =
    (eksik.length ? `<p class="hata">Bu ay girilmeyen: ${eksik.map(kacis).join(', ')}. Yine de gönderebilirsiniz.</p>` : '') +
    `<ul class="dosyalar">${hazirDosyalar.map((d, i) => `<li><a href="${urller[i]}" target="_blank" rel="noopener">${kacis(d.name)}</a><small>${boyutYazi(d.size)}</small></li>`).join('')}</ul>` +
    (paylasilir
      ? `<p class="not">Aşağıdaki tuşa basınca paylaşma menüsü açılır. Orada WhatsApp'ı, sonra muhasebecinizi seçin.</p><button class="ana genis" id="paylas">WhatsApp ile gönder</button>`
      : `<p class="not">Bu tarayıcı doğrudan paylaşmayı desteklemiyor. Dosyalara dokunup tek tek kaydedin, sonra WhatsApp'tan gönderin.</p>`);
  const p = $('#paylas');
  if (p) p.onclick = async () => {
    try {
      await navigator.share({files: hazirDosyalar});
      await ayBilgiYaz({...(ayBilgi || {}), ay, gonderildi: Date.now()});
      $('#gonderP').close();
      await yenile();
    } catch (e) {
      if (e.name !== 'AbortError') ic.insertAdjacentHTML('beforeend', `<p class="hata">Paylaşılamadı: ${kacis(e.message)}</p>`);
    }
  };
}

/* ---------- Yedek al / geri yükle ----------
   Bütün kayıtlar tek .json dosyasına yazılır (belgeler base64). Geri yüklemede hiçbir şey silinmez:
   yedekteki kayıtlar eklenir, aynı kimlikli olan güncellenir. */
const YEDEK_BICIM = 'fatura-defteri-yedek';
const b64Yap = buf => new Promise((ok, hata) => {
  const r = new FileReader();
  r.onload = () => ok(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = () => hata(r.error);
  r.readAsDataURL(new Blob([buf]));
});
const b64Coz = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const sonYedekOku = () => { try { return +localStorage.getItem('son-yedek') || 0; } catch (e) { return 0; } };

async function yedekDosyasi() {
  const tumKayit = await islem('kayit', 'readonly', s => s.getAll());
  const tumAy = await islem('ay', 'readonly', s => s.getAll());
  // Büyük tek yazı yerine parça parça: çok fotoğrafta telefonun belleği yetsin
  const parcalar = [`{"bicim":"${YEDEK_BICIM}","surum":1,"tarih":${Date.now()},"ay":${JSON.stringify(tumAy)},"kayit":[`];
  for (let i = 0; i < tumKayit.length; i++) {
    const {_url, veri, ...k} = tumKayit[i];
    if (veri) k.veri64 = await b64Yap(veri);
    parcalar.push((i ? ',' : '') + JSON.stringify(k));
  }
  parcalar.push(']}');
  const d = new Date();
  const ad = `fatura-defteri-yedek-${d.getFullYear()}-${ikiHane(d.getMonth()+1)}-${ikiHane(d.getDate())}.json`;
  return {dosya: new File(parcalar, ad, {type: 'application/json'}), sayi: tumKayit.length};
}

let yedekUrl = null;
async function yedekAc() {
  const ic = $('#yedekIcerik');
  const son = sonYedekOku();
  ic.innerHTML = `<p class="not">Kayıtlarınız yalnızca bu telefonda duruyor. Telefon değişir, kaybolur ya da uygulama silinirse gider. Ayda bir yedek alıp iCloud Drive'a kaydedin ya da WhatsApp'tan kendinize gönderin.</p>` +
    `<p class="not"><b>Son yedek:</b> ${son ? tarihYazi(bugunStrOf(new Date(son))) : 'hiç alınmadı'}</p>` +
    `<div id="yedekAl"><p class="yukleniyor">Yedek hazırlanıyor…</p></div>` +
    `<label class="ana gri genis" style="margin-top:10px"><input type="file" accept=".json,application/json" id="yedekSec" style="position:absolute;opacity:0;width:1px;height:1px">Yedekten geri yükle</label>` +
    `<p class="hata" id="yedekHata" role="alert"></p>`;
  $('#yedekSec').addEventListener('change', e => { geriYukle(e.target.files[0]); e.target.value = ''; });
  $('#yedekP').showModal();
  const alan = $('#yedekAl');
  let y;
  try { y = await yedekDosyasi(); } catch (e) { alan.innerHTML = `<p class="hata">Yedek hazırlanamadı: ${kacis(e.message)}</p>`; return; }
  if (!y.sayi) { alan.innerHTML = '<p class="not">Henüz kayıt yok, yedeklenecek bir şey yok.</p>'; return; }
  if (yedekUrl) URL.revokeObjectURL(yedekUrl);
  yedekUrl = URL.createObjectURL(y.dosya);
  const paylasilir = !!(navigator.canShare && navigator.canShare({files: [y.dosya]}));
  const isaretle = () => { try { localStorage.setItem('son-yedek', String(Date.now())); } catch (e) {} };
  alan.innerHTML = `<p class="not">${y.sayi} kayıt, ${boyutYazi(y.dosya.size)}.</p>` + (paylasilir
    ? `<button class="ana mavi genis" id="yedekPaylas">Yedeği kaydet</button><p class="not" style="margin-top:8px">Açılan menüde "Dosyalara Kaydet"i (iCloud Drive) ya da WhatsApp'ı seçin.</p>`
    : `<a class="ana mavi genis" style="text-decoration:none" id="yedekIndir" href="${yedekUrl}" download="${kacis(y.dosya.name)}">Yedeği indir</a>`);
  if (paylasilir) $('#yedekPaylas').onclick = async () => {
    try { await navigator.share({files: [y.dosya]}); isaretle(); $('#yedekP').close(); }
    catch (e) { if (e.name !== 'AbortError') $('#yedekHata').textContent = 'Kaydedilemedi: ' + e.message; }
  };
  else $('#yedekIndir').onclick = isaretle;
}
const bugunStrOf = d => `${d.getFullYear()}-${ikiHane(d.getMonth()+1)}-${ikiHane(d.getDate())}`;

async function geriYukle(file) {
  const hataP = $('#yedekHata'); hataP.textContent = '';
  if (!file) return;
  let y;
  try { y = JSON.parse(await file.text()); } catch (e) { hataP.textContent = 'Bu dosya okunamadı. Fatura Defteri yedeği seçtiğinizden emin olun.'; return; }
  if (!y || y.bicim !== YEDEK_BICIM || !Array.isArray(y.kayit) || !Array.isArray(y.ay)) { hataP.textContent = 'Bu bir Fatura Defteri yedeği değil.'; return; }
  const kayitlarY = y.kayit.filter(k => k && typeof k.id === 'string' && typeof k.ay === 'string');
  const tarih = y.tarih ? tarihYazi(bugunStrOf(new Date(y.tarih))) : '?';
  if (!confirm(`${tarih} tarihli yedekte ${kayitlarY.length} kayıt var.\n\nBu telefona eklensin mi? Telefondaki kayıtlar silinmez; aynı kayıt varsa yedektekiyle değiştirilir.`)) return;
  try {
    const hazir = kayitlarY.map(({veri64, ...k}) => ({...k, veri: veri64 ? b64Coz(veri64) : null}));
    await new Promise((ok, hata) => {
      const t = db.transaction(['kayit', 'ay'], 'readwrite');
      hazir.forEach(k => t.objectStore('kayit').put(k));
      y.ay.filter(b => b && typeof b.ay === 'string').forEach(b => t.objectStore('ay').put(b));
      t.oncomplete = ok;
      t.onerror = t.onabort = () => hata(t.error || new Error('Kayıt hatası'));
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    $('#yedekP').close();
    await yenile();
    alert(`${hazir.length} kayıt geri yüklendi.`);
  } catch (e) {
    hataP.textContent = 'Geri yüklenemedi: telefonda yer kalmamış olabilir.';
  }
}

/* ---------- Ana ekrana ekleme uyarısı ---------- */
function seritCiz() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const ekli = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let kapali = false; try { kapali = localStorage.getItem('serit-kapali') === '1'; } catch (e) {}
  if (!ios || ekli || kapali) return;
  $('#serit').innerHTML = `<div class="serit"><b>Önce ana ekrana ekleyin.</b> Safari'de alttaki Paylaş düğmesine, sonra "Ana Ekrana Ekle"ye dokunun. Eklemezseniz iPhone, bir süre açılmayan sayfaların kayıtlarını silebilir.<br><button id="seritKapat">Tamam</button></div>`;
  $('#seritKapat').onclick = () => { try { localStorage.setItem('serit-kapali', '1'); } catch (e) {} $('#serit').innerHTML = ''; };
}

/* ---------- Olaylar ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-ekle],[data-gor],[data-kapat],[data-degistir],[data-gelmedi],[data-gelmedi-geri],[data-ode],[data-rozet],[data-sekme]');
  if (!t) return;
  if (t.dataset.ode) { const p = t.closest('dialog'); odendiDegistir(t.dataset.ode).then(ok => { if (ok && p) p.close(); }); }
  else if (t.hasAttribute('data-rozet')) rozetIzniIste();
  else if (t.dataset.sekme) { sekme = t.dataset.sekme; ciz(); window.scrollTo(0, 0); }
  else if (t.dataset.gelmedi) gelmediDegistir(t.dataset.gelmedi, true);
  else if (t.dataset.gelmediGeri) gelmediDegistir(t.dataset.gelmediGeri, false);
  else if (t.dataset.ekle) ekleAc(t.dataset.ekle);
  else if (t.dataset.gor) gorAc(t.dataset.gor);
  else if (t.hasAttribute('data-kapat')) t.closest('dialog').close();
  else if (t.hasAttribute('data-degistir')) { secilen = null; $('#onizleme').hidden = true; $('#onizleme').style.flexDirection = ''; $('#secim').hidden = false; }
});
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
$('#kamera').addEventListener('change', e => { dosyaGeldi(e.target.files[0]); e.target.value = ''; });
$('#galeri').addEventListener('change', e => { dosyaGeldi(e.target.files[0]); e.target.value = ''; });
$('#dosyaSec').addEventListener('change', e => { dosyaGeldi(e.target.files[0]); e.target.value = ''; });
$('#tur').addEventListener('change', e => { $('#digerAlan').hidden = e.target.value !== DIGER; if (e.target.value === DIGER) $('#digerAd').focus(); });
$('#ekleForm').addEventListener('submit', kaydet);
$('#silBtn').addEventListener('click', sil);
$('#duzenleBtn').addEventListener('click', () => { if (gorulen) duzenleAc(gorulen); });
$('#gonderBtn').addEventListener('click', gonderAc);
$('#yedekBtn').addEventListener('click', yedekAc);
$('#geri').addEventListener('click', () => { ay = ayKaydir(ay, -1); yenile(); });
$('#ileri').addEventListener('click', () => { ay = ayKaydir(ay, 1); yenile(); });
$('#sekmeF').addEventListener('click', () => { sekme = 'fatura'; ciz(); });
$('#sekmeZ').addEventListener('click', () => { sekme = 'z'; ciz(); });
$('#sekmeV').addEventListener('click', () => { sekme = 'vergi'; ciz(); });
$('#sekmeS').addEventListener('click', () => { sekme = 'serkan'; ciz(); });
// Gün değişince (uygulama arkada açık kalmışsa) kalan gün yazıları ve uyarı tazelensin
document.addEventListener('visibilitychange', () => { if (!document.hidden && db) yenile(); });

dbAc().then(yenile).catch(() => {
  $('#klasor').innerHTML = '<p class="bos">Kayıt alanı açılamadı. Safari ayarlarında "Gizli" sekmede değilseniz sayfayı yenileyin.</p>';
});
seritCiz();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
