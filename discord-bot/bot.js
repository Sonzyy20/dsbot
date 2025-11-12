const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

require('dotenv').config();
const TOKEN = process.env.DISCORD_TOKEN;

const PREFIX = '!';
const DATA_FILE = path.join(__dirname, 'marketplace_data.json');
const TEMP_FILE = path.join(__dirname, 'marketplace_temp.jsonl');

let marketCache = [];

// -------- Загрузка данных --------

async function loadLocalData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    marketCache = JSON.parse(data);
    console.log(`✅ Загружено ${marketCache.length} позиций.`);
  } catch {
    console.log('⚠️ Файл данных не найден.');
  }
}

async function saveLocalData() {
  await fs.writeFile(DATA_FILE, JSON.stringify(marketCache, null, 2));
  console.log(`💾 Данные сохранены в ${DATA_FILE} (${marketCache.length} записей)`);
}

// -------- Вспомогательные функции для update --------

function appendToTempFile(data) {
  try {
    const line = JSON.stringify(data) + '\n';
    fsSync.appendFileSync(TEMP_FILE, line);
  } catch (err) {
    console.error('❌ Ошибка записи во временный файл:', err.message);
  }
}

async function mergeNewDataToMainFile() {
  try {
    console.log('🔀 Объединяю новые данные с существующими...');
    let existingData = [];
    try {
      const content = await fs.readFile(DATA_FILE, 'utf8');
      existingData = JSON.parse(content);
    } catch {}

    let newData = [];
    try {
      const tempContent = await fs.readFile(TEMP_FILE, 'utf8');
      const lines = tempContent.trim().split('\n').filter(line => line);
      newData = lines.map(line => JSON.parse(line));
    } catch {
      console.log('⚠️ Временный файл пуст');
      return;
    }

    newData = newData.filter(item => (item.in_stock || 0) >= 1 && (item.is_sold_out || 0) === 0);
    const allData = [...existingData, ...newData];

    const uniqueItems = {};
    for (const item of allData) {
      if (item.id && (item.in_stock || 0) >= 1 && (item.is_sold_out || 0) === 0) {
        uniqueItems[item.id] = item;
      }
    }

    const finalData = Object.values(uniqueItems);
    await fs.writeFile(DATA_FILE, JSON.stringify(finalData, null, 2));
    await fs.writeFile(TEMP_FILE, '');
    console.log(`✅ Объединено: всего ${finalData.length} уникальных записей`);
  } catch (err) {
    console.error('❌ Ошибка слияния данных:', err.message);
  }
}

async function checkId(id) {
  try {
    const response = await axios.get(`https://api.uexcorp.uk/2.0/marketplace_listings/search?id=${id}`, { timeout: 5000 });
    const data = response.data;

    if (data.status === 'ok' && data.data && data.data !== false) {
      const item = data.data;
      const inStock = item.in_stock || 0;
      const isSoldOut = item.is_sold_out || 0;

      if (inStock >= 1 && isSoldOut === 0) {
        return { exists: true, data: item };
      }
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

// -------- Загрузка с API --------

async function fetchMarketData(startId = 2000, endId = 100000, batchSize = 2000) {
  console.log(`\n📋 === RELOAD: Начало полной загрузки ===`);
  console.log(`🔢 Диапазон ID: ${startId} - ${endId}`);
  console.log(`📦 Размер батча: ${batchSize}`);
  console.log(`⏰ Примерное время: ~${Math.ceil((endId - startId) / batchSize * 0.5)} минут\n`);

  marketCache = [];
  let totalFound = 0;
  let totalChecked = 0;
  let batchNumber = 1;
  const totalBatches = Math.ceil((endId - startId) / batchSize);

  // Очищаем временный файл
  if (fsSync.existsSync(TEMP_FILE)) {
    await fs.unlink(TEMP_FILE);
  }

  for (let batchStart = startId; batchStart <= endId; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize - 1, endId);
    let foundInBatch = 0;

    console.log(`\n[Батч ${batchNumber}/${totalBatches}] 🔍 Проверяю диапазон ${batchStart} - ${batchEnd}`);

    for (let id = batchStart; id <= batchEnd; id++) {
      const result = await checkId(id);
      
      if (result.exists) {
        const item = result.data;
        const inStock = item.in_stock || 0;
        const isSoldOut = item.is_sold_out || 0;

        // Добавляем только если товар в наличии и не распродан
        if (inStock >= 1 && isSoldOut === 0) {
          appendToTempFile({ id, ...item });
          foundInBatch++;
          totalFound++;
          
          const itemName = item.title || item.name || item.slug || `ID:${id}`;
          console.log(`   ✅ Найден: ${itemName} (${inStock} шт)`);
        } else {
          console.log(`   ⚠️  ID ${id} пропущен (out of stock или sold out)`);
        }
      }
      
      totalChecked++;
      
      // Небольшая пауза между запросами
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n📊 Батч ${batchNumber} завершен: найдено ${foundInBatch} товаров`);
    console.log(`📈 Общий прогресс: ${totalFound} товаров из ${totalChecked} проверенных ID\n`);

    batchNumber++;
    
    // Пауза между батчами
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Конвертируем временный файл в финальный
  console.log(`\n💾 Сохраняю данные в ${DATA_FILE}...`);
  
  try {
    const content = await fs.readFile(TEMP_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(line => line);
    const allItems = lines.map(line => JSON.parse(line));

    // Удаляем дубликаты
    const uniqueItems = {};
    for (const item of allItems) {
      if (item.id && (item.in_stock || 0) >= 1 && (item.is_sold_out || 0) === 0) {
        uniqueItems[item.id] = item;
      }
    }

    marketCache = Object.values(uniqueItems);
    await saveLocalData();
    
    // Удаляем временный файл
    await fs.unlink(TEMP_FILE);
    
    console.log(`✅ Данные сохранены: ${marketCache.length} уникальных записей`);
  } catch (err) {
    console.error('❌ Ошибка при сохранении:', err.message);
  }

  console.log(`\n✅ === RELOAD: Завершено ===`);
  console.log(`🔍 Всего проверено ID: ${totalChecked}`);
  console.log(`📦 Найдено товаров: ${totalFound}`);
  console.log(`💾 Сохранено уникальных: ${marketCache.length}\n`);

  return marketCache.length;
}

// -------- Обновление старых записей --------

async function updateOldListings() {
  const itemsToUpdate = marketCache.filter(item => (item.in_stock || 0) < 10 && (item.in_stock || 0) > 0);
  let updated = 0;
  let removed = 0;
  let checked = 0;

  console.log(`\n📋 === OLDUPDATE: Начало обновления ===`);
  console.log(`📦 Найдено товаров для проверки: ${itemsToUpdate.length}`);
  console.log(`⏰ Примерное время: ~${Math.ceil(itemsToUpdate.length * 0.15 / 60)} минут\n`);

  for (const item of itemsToUpdate) {
    if (!item.id) continue;
    
    checked++;
    const itemName = item.title || item.name || item.slug || `ID:${item.id}`;
    const oldStock = item.in_stock || 0;
    
    console.log(`[${checked}/${itemsToUpdate.length}] 🔍 Проверяю: ${itemName} (было: ${oldStock} шт)`);
    
    const result = await checkId(item.id);
    
    if (result.exists) {
      // Обновляем данные напрямую в marketCache
      const index = marketCache.findIndex(i => i.id === item.id);
      if (index !== -1) {
        const newStock = result.data.in_stock || 0;
        marketCache[index] = { ...result.data };
        updated++;
        
        if (newStock !== oldStock) {
          console.log(`   ✅ Обновлено: ${oldStock} → ${newStock} шт`);
        } else {
          console.log(`   ℹ️  Без изменений`);
        }
        
        // Сохраняем после каждого обновления
        await saveLocalData();
      }
    } else {
      // Удаляем если товар больше не доступен
      marketCache = marketCache.filter(i => i.id !== item.id);
      removed++;
      console.log(`   ❌ Удалено (распродано или недоступно)`);
      
      // Сохраняем после каждого удаления
      await saveLocalData();
    }
    
    // Прогресс каждые 10 записей
    if (checked % 10 === 0) {
      console.log(`\n📊 Прогресс: ${checked}/${itemsToUpdate.length} | Обновлено: ${updated} | Удалено: ${removed}\n`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  
  console.log(`\n✅ === OLDUPDATE: Завершено ===`);
  console.log(`📝 Проверено: ${itemsToUpdate.length}`);
  console.log(`🔄 Обновлено: ${updated}`);
  console.log(`🗑️  Удалено: ${removed}`);
  console.log(`💾 Все изменения сохранены в ${DATA_FILE}\n`);
  
  return { total: itemsToUpdate.length, updated, removed };
}

// -------- Discord Bot --------

client.once('ready', async () => {
  console.log(`✅ Бот ${client.user.tag} запущен!`);
  await loadLocalData();
});

// ===== ФУНКЦИЯ СОЗДАНИЯ EMBED'ОВ =====

function getPrice(item) {
  if (!item.price) return null;
  if (typeof item.price === 'number') return item.price;
  if (typeof item.price.amount === 'number') return item.price.amount;
  return null;
}

function buildPageEmbeds(results, page, totalPages, listingType = 'sell') {
  const ITEMS_PER_PAGE = 5;
  const start = page * ITEMS_PER_PAGE;
  const slice = results.slice(start, start + ITEMS_PER_PAGE);

  return slice.map(item => {
    const price = getPrice(item);
    const stock = item.in_stock || 0;
    const seller = item.user_name || 'Unknown';
    const url = item.slug ? `https://uexcorp.space/marketplace/item/info/${item.slug}` : null;
    
    // Определяем тип объявления
    const isBuyListing = item.listing_type === 'buy' || item.type === 'buy';
    const listingLabel = isBuyListing ? '🔵 WTB (Покупка)' : '🟢 WTS (Продажа)';

    const color = stock >= 5 ? "#00FF00" : stock >= 2 ? "#F1C40F" : "#FF0000";

    return new EmbedBuilder()
      .setColor(color)
      .setTitle(item.title || item.name || item.slug || "Товар")
      .setThumbnail(item.user_avatar || null)
      .setURL(url)
      .setDescription(
        `${listingLabel}\n` +
        `💰 **Цена:** ${price?.toLocaleString()} aUEC\n` +
        `📦 **В наличии:** ${stock}\n` +
        `👤 ${isBuyListing ? 'Покупатель' : 'Продавец'}: **${seller}**`
      )
      .setFooter({ text: `Страница ${page + 1} из ${totalPages}` })
      .setTimestamp();
  });
}

function pageButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('prev').setLabel('⬅ Назад').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('next').setLabel('Вперед ➡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('close').setLabel('Закрыть').setStyle(ButtonStyle.Danger)
  );
}

function filterButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('filter_all').setLabel('Все').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('filter_sell').setLabel('WTS (Продажа)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('filter_buy').setLabel('WTB (Покупка)').setStyle(ButtonStyle.Primary)
  );
}

// ===== КОМАНДЫ =====

client.on('messageCreate', async message => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ---- HELP ----
  if (command === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('📚 Справка по командам бота')
      .setDescription('Бот для поиска товаров на маркетплейсе UEX Corp')
      .addFields(
        {
          name: '🔍 !search <запрос>',
          value: 'Поиск товаров по названию.\n**Пример:** `!search Gladius`\n' +
                 '• Показывает только товары в наличии\n' +
                 '• Сортирует по цене от меньшей к большей\n' +
                 '• Навигация по страницам с кнопками'
        },
        {
          name: '🔄 !reload',
          value: 'Полная перезагрузка базы данных.\n' +
                 '• Проверяет ID от 2000 до 100,000\n' +
                 '• Добавляет только товары в наличии\n' +
                 '• Пропускает распроданные позиции\n' +
                 '• Может занять продолжительное время\n' +
                 '• Доступно только администраторам'
        },
        {
          name: '⏫ !update',
          value: 'Инкрементальное обновление: догрузить новые товары.\n' +
                 '• Проверяет ID после последнего (до +30,000)\n' +
                 '• Делает это порциями по 2000\n' +
                 '• Сохраняет только товары в наличии\n' +
                 '• Доступно только администраторам'
        },
        {
          name: '🔄 !oldupdate',
          value: 'Обновить информацию о товарах с наличием < 10 шт.\n' +
                 '• Проверяет актуальность данных\n' +
                 '• Удаляет распроданные позиции\n' +
                 '• Доступно только администраторам'
        },
        {
          name: '🧹 !dedupe',
          value: 'Удалить дубликаты и распроданные товары из базы.\n' +
                 '• Очищает базу от неактуальных записей\n' +
                 '• Доступно только администраторам'
        },
        {
          name: '📊 !stats',
          value: 'Показать статистику базы данных.'
        },
        {
          name: '❓ !help',
          value: 'Показать это сообщение.'
        }
      )
      .addFields({
        name: '🎨 Цветовая индикация',
        value: '🟢 ≥5 шт. | 🟡 2–4 шт. | 🔴 1 шт.'
      })
      .setFooter({ text: 'Данные с UEX Corp Space' })
      .setTimestamp();

    return message.reply({ embeds: [helpEmbed] });
  }

  // ---- RELOAD ----
  if (command === 'reload') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Только администраторы могут обновлять базу.');
    }

    const loading = await message.reply('🔄 Начинаю полную перезагрузку базы данных...\n📋 Проверка ID: 2000-100000 (это займет время)');
    
    try {
      const count = await fetchMarketData(2000, 100000, 2000);
      
      const reloadEmbed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Полная перезагрузка завершена')
        .addFields(
          { name: 'Диапазон ID', value: '2000 - 100000', inline: true },
          { name: 'Загружено позиций', value: count.toLocaleString(), inline: true },
          { name: 'Фильтр', value: 'Только товары в наличии', inline: true }
        )
        .setFooter({ text: 'Подробности в консоли сервера' })
        .setTimestamp();
      
      await loading.edit({ content: null, embeds: [reloadEmbed] });
    } catch (error) {
      console.error('❌ Ошибка в reload:', error);
      await loading.edit(`❌ Ошибка загрузки: ${error.message}`);
    }
    return;
  }

  // ---- UPDATE ----
  if (command === 'update') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Только администраторы могут обновлять базу.');
    }

    if (!marketCache.length) {
      return message.reply('⚠️ База данных пуста. Используйте `!reload` перед `!update`.');
    }

    const msg = await message.reply('🔄 Начинаю инкрементальное обновление...');
    const maxId = Math.max(...marketCache.map(i => i.id || 0));
    const startId = maxId + 1;
    const endId = maxId + 30000;
    const BATCH_SIZE = 2000;
    let totalFound = 0;
    let totalChecked = 0;
    let batchNumber = 1;

    for (let batchStart = startId; batchStart <= endId; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endId);
      
      // Очищаем временный файл перед новым батчем
      if (fsSync.existsSync(TEMP_FILE)) {
        await fs.unlink(TEMP_FILE);
      }
      
      let foundInBatch = 0;

      for (let id = batchStart; id <= batchEnd; id++) {
        const result = await checkId(id);
        if (result.exists) {
          appendToTempFile({ id, ...result.data });
          foundInBatch++;
        }
        totalChecked++;
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (foundInBatch > 0) {
        await mergeNewDataToMainFile();
        totalFound += foundInBatch;
      }

      await msg.edit(`✅ Блок ${batchNumber}: найдено ${foundInBatch}, всего найдено: ${totalFound}`);
      batchNumber++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await loadLocalData();
    
    const updateEmbed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('✅ Обновление завершено')
      .addFields(
        { name: 'Проверено ID', value: `${startId} - ${endId} (${totalChecked} ID)`, inline: false },
        { name: 'Найдено новых', value: totalFound.toString(), inline: true },
        { name: 'Всего в базе', value: marketCache.length.toString(), inline: true }
      )
      .setTimestamp();
    
    return msg.edit({ content: null, embeds: [updateEmbed] });
  }

  // ---- OLDUPDATE ----
  if (command === 'oldupdate') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Только администраторы могут обновлять базу.');
    }

    if (!marketCache.length) {
      return message.reply('⚠️ База данных пуста. Используйте `!reload` перед `!oldupdate`.');
    }

    const itemsCount = marketCache.filter(item => (item.in_stock || 0) < 10 && (item.in_stock || 0) > 0).length;
    const msg = await message.reply(`🔄 Начинаю обновление товаров с наличием < 10 шт...\n📦 Найдено: ${itemsCount} позиций для проверки`);
    
    try {
      const result = await updateOldListings();
      
      const oldUpdateEmbed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Обновление старых записей завершено')
        .addFields(
          { name: 'Проверено записей', value: result.total.toString(), inline: true },
          { name: 'Обновлено', value: result.updated.toString(), inline: true },
          { name: 'Удалено (распродано)', value: result.removed.toString(), inline: true },
          { name: 'Всего в базе', value: marketCache.length.toString(), inline: false }
        )
        .setFooter({ text: 'Подробности в консоли сервера' })
        .setTimestamp();
      
      return msg.edit({ content: null, embeds: [oldUpdateEmbed] });
    } catch (error) {
      console.error('❌ Ошибка в oldupdate:', error);
      return msg.edit(`❌ Ошибка обновления: ${error.message}`);
    }
  }

  // ---- DEDUPE ----
  if (command === 'dedupe') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Только администраторы могут выполнять дедупликацию.');
    }

    const msg = await message.reply('🔄 Удаляю дубликаты и распроданные...');
    const originalCount = marketCache.length;
    
    const uniqueItems = {};
    for (const item of marketCache) {
      if (item.id && (item.is_sold_out || 0) === 0 && (item.in_stock || 0) >= 1) {
        uniqueItems[item.id] = item;
      }
    }
    
    marketCache = Object.values(uniqueItems);
    const removedCount = originalCount - marketCache.length;
    await saveLocalData();
    
    const dedupeEmbed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('✅ Дедупликация завершена')
      .addFields(
        { name: 'Было записей', value: originalCount.toString(), inline: true },
        { name: 'Стало записей', value: marketCache.length.toString(), inline: true },
        { name: 'Удалено дубликатов / распроданных', value: removedCount.toString(), inline: true }
      )
      .setTimestamp();
    
    return msg.edit({ content: null, embeds: [dedupeEmbed] });
  }

  // ---- STATS ----
  if (command === 'stats') {
    if (!marketCache.length) {
      return message.reply('⚠️ База данных пуста. Используйте `!reload`');
    }

    const inStock = marketCache.filter(item => (item.in_stock || 0) > 0).length;
    const totalValue = marketCache.reduce((sum, item) => {
      const price = getPrice(item);
      return sum + (price || 0);
    }, 0);

    const statsEmbed = new EmbedBuilder()
      .setColor('#2ecc71')
      .setTitle('📊 Статистика базы данных')
      .addFields(
        { name: '📦 Всего товаров', value: marketCache.length.toLocaleString(), inline: true },
        { name: '✅ В наличии', value: inStock.toLocaleString(), inline: true },
        { name: '💰 Общая стоимость', value: `${totalValue.toLocaleString()} aUEC`, inline: true },
        { name: '📁 Файл данных', value: DATA_FILE, inline: false }
      )
      .setTimestamp();

    return message.reply({ embeds: [statsEmbed] });
  }

  // ---- SEARCH ----
  if (command === 'search') {
    if (!args[0]) return message.reply('❌ Укажите запрос. Пример: `!search Gladius`');
    if (!marketCache.length) return message.reply('⚠️ База данных пуста. Используйте `!reload`');

    const query = args.join(' ').toLowerCase();
    const loading = await message.reply('🔍 Ищу...');

    let allResults = marketCache.filter(item =>
      (item?.title?.toLowerCase().includes(query) ||
       item?.name?.toLowerCase().includes(query) ||
       item?.slug?.toLowerCase().includes(query))
      && (item.is_sold_out || 0) === 0
      && (item.in_stock || 0) >= 1
      && getPrice(item) !== null
    ).sort((a, b) => getPrice(a) - getPrice(b));

    if (!allResults.length) return loading.edit('❌ Ничего не найдено. Попробуйте другой запрос.');

    let currentFilter = 'all'; // 'all', 'sell', 'buy'
    let page = 0;

    function getFilteredResults() {
      if (currentFilter === 'sell') {
        return allResults.filter(item => {
          const isBuy = item.listing_type === 'buy' || item.type === 'buy';
          return !isBuy;
        });
      } else if (currentFilter === 'buy') {
        return allResults.filter(item => {
          const isBuy = item.listing_type === 'buy' || item.type === 'buy';
          return isBuy;
        });
      }
      return allResults;
    }

    function updateMessage() {
      const results = getFilteredResults();
      const totalPages = Math.ceil(results.length / 5);
      
      if (page >= totalPages) page = Math.max(0, totalPages - 1);
      
      const embeds = buildPageEmbeds(results, page, totalPages, currentFilter);
      
      const sellCount = allResults.filter(i => {
        const isBuy = i.listing_type === 'buy' || i.type === 'buy';
        return !isBuy;
      }).length;
      const buyCount = allResults.filter(i => {
        const isBuy = i.listing_type === 'buy' || i.type === 'buy';
        return isBuy;
      }).length;
      
      let filterText = '';
      if (currentFilter === 'all') filterText = 'Все';
      else if (currentFilter === 'sell') filterText = 'WTS (Продажа)';
      else if (currentFilter === 'buy') filterText = 'WTB (Покупка)';
      
      return {
        content: `Найдено: **${allResults.length}** (🟢 WTS: ${sellCount} | 🔵 WTB: ${buyCount})\nФильтр: **${filterText}** | Показано: **${results.length}**`,
        embeds,
        components: [filterButtons(), pageButtons()]
      };
    }

    let msg = await loading.edit(updateMessage());

    const collector = msg.createMessageComponentCollector({ time: 300000 });

    collector.on('collect', async i => {
      if (i.user.id !== message.author.id) {
        return i.reply({ content: "❌ Эти кнопки не для вас.", ephemeral: true });
      }

      // Фильтры
      if (i.customId === 'filter_all') {
        currentFilter = 'all';
        page = 0;
      } else if (i.customId === 'filter_sell') {
        currentFilter = 'sell';
        page = 0;
      } else if (i.customId === 'filter_buy') {
        currentFilter = 'buy';
        page = 0;
      }
      
      // Навигация
      const results = getFilteredResults();
      const totalPages = Math.ceil(results.length / 5);
      
      if (i.customId === 'next') page = Math.min(page + 1, totalPages - 1);
      if (i.customId === 'prev') page = Math.max(page - 1, 0);
      if (i.customId === 'close') return i.message.delete().catch(() => {});

      await i.update(updateMessage());
    });

    collector.on('end', () => {
      msg.edit({ components: [] }).catch(() => {});
    });
  }
});

// -------- Запуск --------
client.login(TOKEN);