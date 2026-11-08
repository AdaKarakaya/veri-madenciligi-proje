# Load Trading Bot

Binance için basit bir **dalgalanma (swing) al-sat botu** ve içinde yerleşik bir yapay zekâ asistanı,
**Borsa Yardımcısı**. Okul projesi olarak hazırlandı: kurulumu ve kullanımı basit, kuralları sabit ve açık.

## Çalıştırma

1. Bilgisayarda Node.js 20 veya üstü olmalı (https://nodejs.org).
2. `start.bat`'a çift tıkla. İlk açılışta Borsa Yardımcısı'nın kütüphanesi bir kez kurulur (`npm install`).
3. Panel tarayıcıda kendiliğinden açılır: http://127.0.0.1:8790

Komutla: `npm start` (çalıştırır), `npm test` (testler).

## Üç çalışma modu

| Mod | Ne zaman | Ne olur |
|---|---|---|
| **TEST MODE** | API anahtarı yokken (varsayılan) ya da üstteki anahtar "Test mode"dayken | 1.000 sahte USDT, Binance'in **gerçek, canlı fiyatları**, %0,1 işlem ücreti. Coin hareketleri gerçek, para sahte: hoca anahtarsız deneyebilir. |
| **BINANCE TESTNET** | Testnet anahtarı kaydedilince | Binance'in test borsasında (testnet.binance.vision) deneme parasıyla gerçek emirler. |
| **BINANCE LIVE** | Gerçek anahtar kaydedilip "Testnet" işareti kaldırılınca | Gerçek parayla işlem. |

Sayfanın üstündeki **Test mode / My Binance account** anahtarı ikisi arasında geçer (anahtar kaydedilince Binance'e geçer;
anahtar yokken "My Binance account" seni Settings'teki anahtar alanına götürür). Bot çalışırken başlıkta yeşil **WORKING**,
Pause'dayken kırmızı **PAUSED** yazar.
Her mod kendi planını ve işlemlerini ayrı tutar: test modunda denediğin şey gerçek hesabı etkilemez.
API anahtarına sadece **spot işlem** izni ver; para çekme izni gerekmez ve verilmemeli.

**Test cüzdanı hazır gelir:** 1.000 sahte USDT'nin 900'ü, 12 bilinen coin (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX,
LINK, TRX, LTC, DOT) arasından seçilen 3 coine 300'er USDT olarak yatırılmış başlar; 100 USDT yedekte kalır. Seçim son 3
ayın gerçek fiyatlarıyla yapılır:
1. Her coin %10, %12 ve %15 dalgalanmayla simüle edilir.
2. Sadece **hem toplamda kârda biten hem de en az bir döngü (satış + geri alım) tamamlayan** coinler sayılır.
3. Her oranda bunlar döngülerin kazancına göre sıralanır; **ilk 3'ünün toplam getirisi en yüksek olan oran** seçilir,
   planın dalgalanma yüzdesi o olur ve o 3 coin cüzdana girer.

Settings → Reset test balance seçimi yeniden yapar. 1 ay yerine 3 ay: düşen bir ayda neredeyse hiç döngü olmuyor.

**Coin eklerken kontrol:** Add a coin kutusuna coin yazınca altında önce "Checking how profitable … was over the last
1 month…" çıkar, sonra o coinin gerçek fiyatlarıyla bu algoritmanın **son 1 ayda** kaç döngü yapıp ne kazandıracağı,
toplamda yüzde kaç getireceği ve sadece tutmaya göre farkı yazar; altında aynısı son 3 ay için. Buna bakıp eklenir.

## Geçmiş fiyatlarla simülasyon

Bölümün üstünde, son 3 ayda **döngüleri en çok kazandıran 3 coin** yazar (ör. "DOT +$83.75 · 3 cycles"); birine tıklayınca
simülasyon o coinle çalışır.

Trading plan sayfasındaki **Simulate on past prices**: bir coin (ör. SOL), başlangıç USDT'si ve dalgalanma yüzdesi
seçilir. Plan, o coinin Binance'teki **son 90 günlük gerçek fiyatları** üzerinde birkaç saniyede çalıştırılır
(1 saatlik mumların kapanış fiyatları, %0,1 ücretle). Sonuç: planla ulaşılan bakiye,
**sadece alıp tutmaya** göre farkı, döngü ve base yükseltme sayısı, fiyat grafiğinde satış (kırmızı) ve alış (yeşil)
noktaları ve tüm işlemler. Hiçbir şey alınıp satılmaz: hocanın stratejiyi günlerce beklemeden görmesi için.

## Strateji (dalgalanmadan faydalanma)

Plana eklenen her coin için bir **base value** (taban değer) tutulur: coin eklendiği andaki değeri.

1. **Satış:** Coinin değeri base'in **%15 üstüne** çıkınca, base'in üstündeki kısım satılır. Elde kalan coin tekrar base değerindedir.
2. **Geri alım:** Fiyat o satışın fiyatından **%15 düşünce**, satıştan gelen USDT'nin tamamıyla **aynı coin** geri alınır. Daha ucuza alındığı için satılandan **daha fazla coin** gelir. Bir satış ve geri alımı bir **döngü**dür, kazanılan coin o döngünün kârıdır.
3. **Base güncelleme (re-base):** Belirlenen sayıda döngüden sonra (varsayılan **2**), bekleyen geri alım kalmamışsa ve coinin değeri *ilk base + o döngülerin kârı* kadar ya da üstündeyse, **yeni base o anki değer olur**. Böylece bakiye büyüdükçe sonraki dalgalanmalar da büyüyen bakiyeyle işlem görür. Sayı Settings'ten değiştirilebilir.
4. **Stop-loss:** Coin **2 saat içinde %50** değer kaybederse (art arda 3 kontrolde görülürse) tamamı USDT'ye satılır ve o coin için plan durur.

Örnek (%15): 100 USDT'lik SOL, fiyat 1,00 → 1,15 olunca ~13 SOL ~15 USDT'ye satılır.
Fiyat 0,9775'e (1,15 × 0,85) inince 15 USDT ile ~15,35 SOL geri alınır: elde ~102,3 SOL olur, yani ~2,3 SOL kâr.

Fiyat 10 saniyede bir kontrol edilir. Emirler USDT karşılığı piyasa emridir ve Binance'in en küçük emir sınırı (genelde 5 USDT) geçerlidir.

## Sayfalar

**Trading plan**
- En üstte toplam bakiye ve zaman içindeki grafiği (24 saat / 7 gün / 30 gün / tümü).
- Bakiyenin hangi varlıklarda olduğu (çubuk ve tablo).
- Cüzdan: Binance hesabı (tek cüzdan), işleme hazır USDT ve dalgalanmalardan gelen kâr.
- Plan: dalgalanma yüzdesi (%10 / %12 / %15 / %20 / %25), stop-loss ve re-base kuralları. Her coin için: elde olan, base,
  bir sonraki satış fiyatı, bekleyen geri alımlar, döngü sayısı ve kâr. Coin ekleme: sembol + kaç USDT ile alınacağı.
  USDT boş bırakılırsa hesapta zaten olan coin kullanılır. **Stop** coini plandan çıkarır, coinler hesapta kalır.
  **Sell all** hepsini USDT'ye satar.
- Son olaylar ve işlemler.

**Settings**
- Binance API anahtarı ve gizli anahtar (+ Testnet işareti), bağlantı testi.
- Borsa Yardımcısı için Anthropic API anahtarı.
- Re-base döngü sayısı.
- Botun sabit kuralları (sadece gösterilir).
- Test bakiyesini sıfırlama (1.000 USDT'ye döner).

## Borsa Yardımcısı

Her sayfanın sağ alt köşesindeki yuvarlak düğme sohbet penceresini açar. Borsa ve coinler hakkındaki
soruları Claude (Anthropic, `claude-opus-5-5`) ile cevaplar:
- **internetten araştırır** (güncel haberler, gelişmeler) ve kaynakları cevabın altında gösterir,
- coinin **canlı Binance fiyatını** ve 24 saatlik değişimini okur,
- **botun kendi durumunu** (bakiye, plan, son işlemler) okuyup ona göre cevap verir.

Anthropic API anahtarı gerekir (console.anthropic.com), ücretli kullanımdır. Asistan bilgi verir; al-sat kararı kullanıcınındır.

## Dosyalar

```
src/strategy.js   strateji kuralları (saf fonksiyonlar)
src/binance.js    Binance REST API (imzalı istekler) ve test bakiyesi
src/simulate.js   geçmiş fiyatlarla simülasyon (aynı strateji kodu)
src/bot.js        döngü: fiyatları okur, kurala göre emir verir
src/assistant.js  Borsa Yardımcısı (Claude + internet araması + araçlar)
src/server.js     panelin API'si (sadece bu bilgisayardan: 127.0.0.1)
src/panel.html    arayüz
data/             ayarlar, durum, bakiye geçmişi (API anahtarları burada!)
test/             testler (npm test)
```

**Projeyi paylaşırken `data` klasörünü koyma:** API anahtarların `data/settings.json` içinde.
