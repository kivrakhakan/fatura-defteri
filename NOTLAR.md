# Fatura Defteri (iPhone web uygulaması)

- Amaç: kira, elektrik, su, güvenlik alarmı vb. faturalar ve günlük Z raporları telefona yüklenir; ay sonunda PDF yapılıp WhatsApp'tan muhasebeye gönderilir.
- Kullanıcı: tek kişi, iPhone. Veriler yalnızca telefonda (IndexedDB), internete gönderilmez.
- Dosyalar: `index.html` (görünüm), `app.js` (mantık), `sw.js` (çevrimdışı), `vendor/jspdf.umd.min.js` (jsPDF 2.5.2), `simge-yap.ps1` (simgeleri çizer).
- PDF'teki yazılar tuval (canvas) üzerinde çizilip resim olarak ekleniyor (jsPDF'in yazı tipi Türkçe harfleri desteklemediği için).
- Gönderme iki adımlı: önce dosyalar hazırlanıyor, sonra "WhatsApp ile gönder" tuşu (iOS, paylaşımın dokunuşla başlamasını istiyor).
- Yerel test: launch.json `fatura-defteri` (python http.server 8094).
- Muhasebeye giden PDF'lerde TUTAR ve TOPLAM YOK (kullanıcı isteği: muhasebe belgeden kendisi okusun). Tutarlar yalnızca uygulamada görünür.
- Klasörler: Faturalar, Z raporları (ay sonu muhasebeye gider), Vergiler ve Serkan (ödeme takibi: son ödeme tarihi + ödendi tiki; ödenmeyen ödenene kadar görünür, muhasebeye GİTMEZ). Serkan belge istemez, sadece yazı ("Turkcell annem 200 TL"). Serkan kayıtları AYLIK: ödendi denince sonraki ayın aynı günü (yoksa ay sonu, `odemeGunu` saklanır) yeni kayıt açılır; geri alınınca o açık kayıt silinir (`sonrakiId`). Durdurmak = açık kaydı silmek.
- Fatura türü "Bu ay gelmedi" işaretlenebilir (ay kaydında `gelmedi` listesi).
- Uyarı: son günü <=3 gün kalan ödemeler için üstte kırmızı şerit + iPhone simgesinde sayı (setAppBadge, bildirim izni ister). Takvim KULLANILMIYOR (kullanıcı: arkada silinmeyen kayıt kalmasın). Uygulama kapalıyken bildirim yok (sunucu gerekir).
- Her kayıtta "Düzenle" (gorP → duzenleAc; id/ay/ödendi korunur). Gider simgeleri `SIMGELER` (kira = dükkân, ev DEĞİL); arayüzde "PDF" yazısı yok.
- Yedek (2026-11-28): üstte ⬇ düğmesi (`yedekBtn` → `yedekAc`). Tek .json (`bicim: fatura-defteri-yedek`, belgeler `veri64` base64, parça parça Blob). Geri yükleme birleştirir, silmez (aynı id güncellenir). Son yedek tarihi localStorage `son-yedek`.
- Excel (2026-11-28): aynı ⬇ penceresinde (`excelHazirla` → `excelYap`). Kütüphanesiz gerçek .xlsx (sıkıştırmasız zip, `zipYap`+`crc32`). Tek sayfa "Kayıtlar": Tarih, Ay, Klasör, Tür, Tutar, Durum, Not; filtreli, başlık sabit. Tutarlar VAR (kullanıcı için). Bilgisayardaki Excel'de açılıp doğrulandı.
- Sıradaki öneriler (onay bekliyor): ay sonu hatırlatma şeridi, eksik Z günü uyarısı (Z'de "Rapor günü" alanına bakar, fotoğrafı okumaz), arama, PIN kilidi. Geçen yılla karşılaştırma ERTELENDİ (veri yeni, 1 yıl sonra).
- Yayın: https://kivrakhakan.github.io/fatura-defteri/ (GitHub Pages, depo kivrakhakan/fatura-defteri, dal main).
  Güncelleme: değişiklikleri git ile işle, sonra Terminal panelinde `& F:\Denemeler\fatura-defteri\yayinla.cmd` çalıştır
  (bu bilgisayarda .ps1 betikleri engelli; GitHub girişi kodla, github.com/login/device). sw.js içindeki SURUM'u artır.
- Durum 2026-11-27: bilgisayarda test edildi (ekleme, PDF, silme), yayında. iPhone'da kurulum kullanıcıda, henüz denenmedi.
