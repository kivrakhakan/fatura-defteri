'use strict';
/* Fatura Defteri: faturaları ve Z raporlarını aya göre saklar, ay sonunda PDF yapıp paylaşır.
   Her şey telefonda (IndexedDB) durur; internete hiçbir şey gönderilmez. */

const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const GUNLER = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
const TURLER = ['Kira','Elektrik','Su','Güvenlik alarmı'];
const DIGER = '__diger__';

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
    const r = indexedDB.open('fatura-defteri', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kayit', {keyPath: 'id'}).createIndex('ay', 'ay');
      d.createObjectStore('ay', {keyPath: 'ay'});
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
const kayitYaz = k => islem('kayit', 'readwrite', s => s.put(k));
const kayitSil = id => islem('kayit', 'readwrite', s => s.delete(id));
const ayBilgiGetir = ay => islem('ay', 'readonly', s => s.get(ay));
const ayBilgiYaz = b => islem('ay', 'readwrite', s => s.put(b));

/* ---------- Durum ---------- */
let ay = ayOf(bugunStr());
let sekme = 'fatura';
let kayitlar = [];
let ayBilgi = null;
const blobUrl = k => { if (!k._url) k._url = URL.createObjectURL(new Blob([k.veri], {type: k.tip})); return k._url; };

async function yenile() {
  kayitlar.forEach(k => k._url && URL.revokeObjectURL(k._url));
  kayitlar = await kayitlariGetir(ay);
  ayBilgi = await ayBilgiGetir(ay);
  ciz();
}

const faturalar = () => kayitlar.filter(k => k.klasor === 'fatura').sort((a, b) => a.eklendi - b.eklendi);
const zler = () => kayitlar.filter(k => k.klasor === 'z').sort((a, b) => a.tarih.localeCompare(b.tarih) || a.eklendi - b.eklendi);
const topla = liste => liste.reduce((t, k) => t + (k.tutar || 0), 0);

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

  const girilen = TURLER.filter(t => f.some(k => k.tur === t)).length;
  $('#sayF').textContent = `${girilen}/${TURLER.length}`;
  $('#sayZ').textContent = z.length ? String(z.length) : '';
  $('#sekmeF').setAttribute('aria-selected', sekme === 'fatura');
  $('#sekmeZ').setAttribute('aria-selected', sekme === 'z');

  const kl = $('#klasor');
  kl.className = 'klasor ' + (sekme === 'fatura' ? 'f' : 'z');
  kl.innerHTML = sekme === 'fatura' ? faturaHtml(f) : zHtml(z);

  const parca = [];
  if (f.length) parca.push(`${f.length} fatura`);
  if (z.length) parca.push(`${z.length} Z raporu`);
  $('#ozet').textContent = parca.length ? parca.join(', ') + ' gönderilecek' : 'Bu ay henüz bir şey eklenmedi';
  $('#gonderBtn').disabled = !kayitlar.length;
}

function kucukResim(k) {
  return k.tip === 'application/pdf' ? '<span class="kucuk">PDF</span>' : `<img class="kucuk" src="${k.kucuk}" alt="">`;
}

function faturaHtml(f) {
  const adlar = [...TURLER];
  f.forEach(k => { if (!adlar.includes(k.tur)) adlar.push(k.tur); });
  let h = '';
  for (const ad of adlar) {
    const liste = f.filter(k => k.tur === ad);
    const alt = liste.length
      ? `<small>${liste.length > 1 ? liste.length + ' fatura, ' : ''}${para(topla(liste))}</small>`
      : `<small class="eksik">Bu ay girilmedi</small>`;
    h += `<div class="satir"><span class="tik${liste.length ? ' var' : ''}"></span>
      <div class="ad"><b>${kacis(ad)}</b>${alt}</div>
      <button class="ekle" data-ekle="${kacis(ad)}" aria-label="${kacis(ad)} faturası ekle">${liste.length ? '+ Bir tane daha' : '+ Ekle'}</button></div>`;
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
      ${k.tip === 'application/pdf' ? '<span class="kucuk">PDF</span>' : `<img class="fis" src="${k.kucuk}" alt="">`}
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

function ekleAc(tur) {
  ekleKlasor = tur === 'Z raporu' ? 'z' : 'fatura';
  secilen = null;
  $('#ekleForm').reset();
  $('#onizleme').hidden = true; $('#onizleme').innerHTML = '';
  $('#secim').hidden = false;
  $('#ekleHata').textContent = '';
  $('#ekleBaslik').textContent = ekleKlasor === 'z' ? 'Z raporu ekle' : 'Fatura ekle';
  $('#turAlan').hidden = ekleKlasor === 'z';
  $('#tarihEtiket').textContent = ekleKlasor === 'z' ? 'Rapor günü' : 'Fatura tarihi';

  const sec = $('#tur');
  const adlar = [...TURLER];
  faturalar().forEach(k => { if (!adlar.includes(k.tur)) adlar.push(k.tur); });
  sec.innerHTML = adlar.map(a => `<option>${kacis(a)}</option>`).join('') + `<option value="${DIGER}">Diğer…</option>`;
  sec.value = ekleKlasor === 'fatura' ? (tur === DIGER ? DIGER : tur) : TURLER[0];
  $('#digerAlan').hidden = sec.value !== DIGER;

  const tarih = $('#tarih');
  tarih.min = `${ay}-01`; tarih.max = `${ay}-${ikiHane(ayGunSayisi(ay))}`;
  const bugun = bugunStr();
  tarih.value = ayOf(bugun) === ay ? bugun : tarih.max;
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
  if (!secilen) { hataP.textContent = 'Önce fotoğraf çekin ya da bir dosya seçin.'; return; }
  let tur = 'Z raporu';
  if (ekleKlasor === 'fatura') {
    tur = $('#tur').value;
    if (tur === DIGER) {
      tur = $('#digerAd').value.trim();
      if (!tur) { hataP.textContent = 'Faturanın adını yazın.'; $('#digerAd').focus(); return; }
    }
  }
  const tutar = tutarOku($('#tutar').value);
  if (Number.isNaN(tutar)) { hataP.textContent = 'Tutarı yalnızca rakamla yazın, örneğin 1.250,40'; $('#tutar').focus(); return; }
  const tarih = $('#tarih').value || `${ay}-01`;
  const k = {
    id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
    ay, klasor: ekleKlasor, tur, tutar, tarih, not: $('#notAlan').value.trim(),
    veri: secilen.veri, tip: secilen.tip, ad: secilen.ad, kucuk: secilen.kucuk, eklendi: Date.now()
  };
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
  const k = kayitlar.find(x => x.id === id);
  if (!k) return;
  gorulen = k;
  $('#gorBaslik').textContent = k.klasor === 'z' ? 'Z raporu' : k.tur;
  $('#gorIcerik').innerHTML = k.tip === 'application/pdf'
    ? `<p><a class="ekle" href="${blobUrl(k)}" target="_blank" rel="noopener">PDF'i aç</a></p>`
    : `<img src="${blobUrl(k)}" alt="">`;
  $('#gorBilgi').innerHTML =
    `<dt>Tutar</dt><dd>${k.tutar != null ? para(k.tutar) : 'Girilmedi'}</dd>` +
    `<dt>Tarih</dt><dd>${tarihYazi(k.tarih)}</dd>` +
    (k.not ? `<dt>Not</dt><dd>${kacis(k.not)}</dd>` : '');
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
function ozetSayfalari(baslik, altBaslik, sutunlar, satirlar, toplamYazi, dipnotlar) {
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
  y += 10; x.fillRect(KENAR, y - 30, SW - 2 * KENAR, 2); y += 16;
  yazi(x, 30, true); x.fillText('Toplam', KENAR, y);
  x.textAlign = 'right'; x.fillText(toplamYazi, SW - KENAR, y); x.textAlign = 'left';
  y += 70;
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
  const alt = [tarihYazi(k.tarih), k.tutar != null ? para(k.tutar) : null, k.not || null].filter(Boolean).join('   ');
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
    const satirlar = f.map(k => ({h: [k.tur, tarihYazi(k.tarih), k.not || '', k.tutar != null ? para(k.tutar) : 'Girilmedi']}));
    TURLER.filter(t => !f.some(k => k.tur === t)).forEach(t => satirlar.push({h: [t, '', 'Bu ay girilmedi', ''], renk: '#B3261E', renkSutun: 2}));
    const sutunlar = [{ad: 'Fatura', x: KENAR, g: 300}, {ad: 'Tarih', x: KENAR + 320, g: 230}, {ad: 'Not', x: KENAR + 570, g: 260}, {ad: 'Tutar', x: SW - KENAR - 210, g: 210, sag: true}];
    const dip = [`${f.length} fatura. Hazırlanma tarihi: ${bugun}.`];
    if (pdfDosyalar.length) dip.push(`PDF olarak gelen ${pdfDosyalar.length} fatura ayrı dosya olarak eklendi.`);
    const ozet = ozetSayfalari(`${etiket} faturaları`, 'Aylık gider faturaları', sutunlar, satirlar, para(topla(f)), dip);
    ozet.forEach((c, i) => sayfaEkle(pdf, c, i === 0));
    for (const k of f) if (k.tip !== 'application/pdf') sayfaEkle(pdf, await fotoSayfasi(k, `${k.tur} faturası`), false);
    dosyalar.push(new File([pdf.output('blob')], `${onEk}-Faturalar.pdf`, {type: 'application/pdf'}));
    pdfDosyalar.forEach((k, i) => dosyalar.push(new File([k.veri], `${onEk}-${dosyaAdiTemiz(k.tur)}${pdfDosyalar.length > 1 ? '-' + (i + 1) : ''}.pdf`, {type: 'application/pdf'})));
  }

  if (z.length) {
    const pdf = pdfBaslat();
    const pdfDosyalar = z.filter(k => k.tip === 'application/pdf');
    const satirlar = z.map(k => ({h: [tarihYazi(k.tarih, true), k.not || '', k.tutar != null ? para(k.tutar) : '']}));
    const sutunlar = [{ad: 'Gün', x: KENAR, g: 420}, {ad: 'Not', x: KENAR + 440, g: 360}, {ad: 'Tutar', x: SW - KENAR - 230, g: 230, sag: true}];
    const dip = [`${z.length} Z raporu. Hazırlanma tarihi: ${bugun}.`];
    if (pdfDosyalar.length) dip.push(`PDF olarak gelen ${pdfDosyalar.length} Z raporu ayrı dosya olarak eklendi.`);
    const ozet = ozetSayfalari(`${etiket} Z raporları`, 'Günlük kasa raporları', sutunlar, satirlar, para(topla(z)), dip);
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
  const eksik = TURLER.filter(t => !f.some(k => k.tur === t));
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
      await ayBilgiYaz({ay, gonderildi: Date.now()});
      $('#gonderP').close();
      await yenile();
    } catch (e) {
      if (e.name !== 'AbortError') ic.insertAdjacentHTML('beforeend', `<p class="hata">Paylaşılamadı: ${kacis(e.message)}</p>`);
    }
  };
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
  const t = e.target.closest('[data-ekle],[data-gor],[data-kapat],[data-degistir]');
  if (!t) return;
  if (t.dataset.ekle) ekleAc(t.dataset.ekle);
  else if (t.dataset.gor) gorAc(t.dataset.gor);
  else if (t.hasAttribute('data-kapat')) t.closest('dialog').close();
  else if (t.hasAttribute('data-degistir')) { secilen = null; $('#onizleme').hidden = true; $('#onizleme').style.flexDirection = ''; $('#secim').hidden = false; }
});
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
$('#kamera').addEventListener('change', e => { dosyaGeldi(e.target.files[0]); e.target.value = ''; });
$('#dosyaSec').addEventListener('change', e => { dosyaGeldi(e.target.files[0]); e.target.value = ''; });
$('#tur').addEventListener('change', e => { $('#digerAlan').hidden = e.target.value !== DIGER; if (e.target.value === DIGER) $('#digerAd').focus(); });
$('#ekleForm').addEventListener('submit', kaydet);
$('#silBtn').addEventListener('click', sil);
$('#gonderBtn').addEventListener('click', gonderAc);
$('#geri').addEventListener('click', () => { ay = ayKaydir(ay, -1); yenile(); });
$('#ileri').addEventListener('click', () => { ay = ayKaydir(ay, 1); yenile(); });
$('#sekmeF').addEventListener('click', () => { sekme = 'fatura'; ciz(); });
$('#sekmeZ').addEventListener('click', () => { sekme = 'z'; ciz(); });

dbAc().then(yenile).catch(() => {
  $('#klasor').innerHTML = '<p class="bos">Kayıt alanı açılamadı. Safari ayarlarında "Gizli" sekmede değilseniz sayfayı yenileyin.</p>';
});
seritCiz();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
