const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

require('dotenv').config();
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';
const DATA_FILE = path.join(__dirname, 'marketplace_data.json');
const TEMP_FILE = path.join(__dirname, 'marketplace_temp.jsonl'); // Временный файл для записи

let marketCache = [];

// Загрузка данных из локального файла
async function loadLocalData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    marketCache = JSON.parse(data);
    console.log(`✅ Загружено ${marketCache.length} позиций из локального файла.`);
    return true;
  } catch (err) {
    console.log('⚠️ Локальный файл не найден, начинаю сканирование API...');
    return false;
  }
}

// Сохранение данных в локальный файл
async function saveLocalData() {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(marketCache, null, 2));
    console.log(`💾 Данные сохранены в ${DATA_FILE} (${marketCache.length} записей)`);
  } catch (err) {
    console.error('❌ Ошибка при сохранении данных:', err.message);
  }
}

// Добавление записи в временный файл (потоковая запись)
function appendToTempFile(data) {
  try {
    const line = JSON.stringify(data) + '\n';
    fsSync.appendFileSync(TEMP_FILE, line);
  } catch (err) {
    console.error('❌ Ошибка записи во временный файл:', err.message);
  }
}

// Конвертация временного файла в финальный JSON
async function convertTempToFinal() {
  try {
    console.log('📝 Конвертирую временный файл в финальный JSON...');
    const content = await fs.readFile(TEMP_FILE, 'utf8');
    const lines = content.trim().split('\n');
    const allItems = lines.map(line => JSON.parse(line));
    
    // Удаляем дубликаты по ID (оставляем последнюю запись)
    const uniqueItems = {};
    for (const item of allItems) {
      if (item.id) {
        uniqueItems[item.id] = item;
      }
    }
    
    const items = Object.values(uniqueItems);
    const duplicatesRemoved = allItems.length - items.length;
    
    console.log(`🔄 Удалено дубликатов: ${duplicatesRemoved}`);
    
    await fs.writeFile(DATA_FILE, JSON.stringify(items, null, 2));
    await fs.unlink(TEMP_FILE); // Удаляем временный файл
    
    console.log(`✅ Конвертация завершена: ${items.length} уникальных записей сохранено`);
  } catch (err) {
    console.error('❌ Ошибка конвертации:', err.message);
  }
}

// Слияние новых данных из временного файла с основным
async function mergeNewDataToMainFile() {
  try {
    console.log('🔀 Объединяю новые данные с существующими...');
    
    // Читаем существующие данные
    let existingData = [];
    try {
      const content = await fs.readFile(DATA_FILE, 'utf8');
      existingData = JSON.parse(content);
    } catch (err) {
      console.log('⚠️ Основной файл не найден, создаю новый');
    }
    
    // Читаем новые данные из временного файла
    let newData = [];
    try {
      const tempContent = await fs.readFile(TEMP_FILE, 'utf8');
      const lines = tempContent.trim().split('\n').filter(line => line);
      newData = lines.map(line => JSON.parse(line));
    } catch (err) {
      console.log('⚠️ Временный файл пуст');
      return;
    }
    
    // Объединяем данные
    const allData = [...existingData, ...newData];
    
    // Удаляем дубликаты по ID
    const uniqueItems = {};
    for (const item of allData) {
      if (item.id) {
        uniqueItems[item.id] = item;
      }
    }
    
    const finalData = Object.values(uniqueItems);
    
    // Сохраняем
    await fs.writeFile(DATA_FILE, JSON.stringify(finalData, null, 2));
    
    console.log(`✅ Объединено: было ${existingData.length}, добавлено ${newData.length}, итого ${finalData.length} уникальных`);
    
    // Очищаем временный файл
    await fs.writeFile(TEMP_FILE, '');
    
  } catch (err) {
    console.error('❌ Ошибка слияния данных:', err.message);
  }
}

// Проверка одного ID
async function checkId(id) {
  try {
    const response = await axios.get(`https://api.uexcorp.uk/2.0/marketplace_listings/search?id=${id}`, {
      timeout: 5000
    });
    const data = response.data;
    
    if (data.status === 'ok' && data.data && data.data !== false) {
      // Фильтруем только товары в наличии (in_stock >= 1)
      const inStock = data.data.in_stock || 0;
      if (inStock >= 1) {
        return { exists: true, data: data.data };
      } else {
        console.log(`⚠️ ID ${id} - найден, но out of stock (${inStock})`);
        return { exists: false };
      }
    }
    return { exists: false };
  } catch (err) {
    return { exists: false };
  }
}

// Сканирование диапазона ID
async function scanRange(startId, endId, step = 1) {
  console.log(`🔍 Сканирую диапазон ${startId} - ${endId} с шагом ${step}`);
  let found = 0;
  
  for (let id = startId; id <= endId; id += step) {
    console.log(`🔎 Детальная проверка ID: ${id}`);
    const result = await checkId(id);
    
    if (result.exists) {
      console.log(`✅ ID ${id} - НАЙДЕН!`);
      const item = { id: id, ...result.data };
      
      // Записываем сразу в файл вместо массива
      appendToTempFile(item);
      found++;
    }
    
    if (id % 100 === 0) {
      console.log(`📊 Проверено до ID: ${id}, найдено: ${found}`);
    }
    
    // Задержка между запросами (500ms)
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return found;
}

// Умное сканирование всех ID
async function scanAllListings() {
  console.log('🚀 Начинаю умное сканирование marketplace...');
  
  // Удаляем старый временный файл если есть
  try {
    if (fsSync.existsSync(TEMP_FILE)) {
      await fs.unlink(TEMP_FILE);
    }
  } catch (err) {
    // Игнорируем ошибку
  }
  
  marketCache = [];
  
  // Этап 1: Быстрое сканирование каждого 10-го ID для поиска диапазонов
  console.log('📡 Этап 1: Поиск активных диапазонов (каждый 10-й ID)...');
  const STEP = 10;
  const MAX_ID = 50000; // Максимальный ID для проверки
  const activeRanges = [];
  let lastFoundId = null;
  let consecutiveEmpty = 0;
  
  for (let id = 1; id <= MAX_ID; id += STEP) {
    console.log(`🔎 Проверяю ID: ${id}`);
    const result = await checkId(id);
    
    if (result.exists) {
      console.log(`✅ ID ${id} - НАЙДЕН!`);
      if (lastFoundId === null || id - lastFoundId > STEP * 2) {
        // Начало нового диапазона
        activeRanges.push({ start: Math.max(1, id - STEP), end: id });
      } else {
        // Расширение существующего диапазона
        activeRanges[activeRanges.length - 1].end = id;
      }
      lastFoundId = id;
      consecutiveEmpty = 0;
      
      // Сохраняем найденный ID сразу в файл
      appendToTempFile({ id: id, ...result.data });
    } else {
      consecutiveEmpty++;
    }
    
    // Если 500 пустых ID подряд (5000 с шагом 10) - останавливаемся
    if (consecutiveEmpty > 500) {
      console.log(`⛔ Остановка: ${consecutiveEmpty * STEP} пустых ID подряд`);
      break;
    }
    
    if (id % 1000 === 0) {
      console.log(`📊 Быстрое сканирование: проверено до ${id}, найдено диапазонов: ${activeRanges.length}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`✅ Этап 1 завершен. Найдено ${activeRanges.length} активных диапазонов.`);
  
  // Этап 2: Детальное сканирование найденных диапазонов
  if (activeRanges.length > 0) {
    console.log('🔬 Этап 2: Детальное сканирование активных диапазонов...');
    
    for (let i = 0; i < activeRanges.length; i++) {
      const range = activeRanges[i];
      console.log(`📍 Диапазон ${i + 1}/${activeRanges.length}: ${range.start} - ${range.end}`);
      
      // Расширяем диапазон на 20 ID в каждую сторону для надежности
      const expandedStart = Math.max(1, range.start - 20);
      const expandedEnd = range.end + 20;
      
      await scanRange(expandedStart, expandedEnd, 1);
    }
  }
  
  console.log(`✅ Сканирование завершено!`);
  
  // Конвертируем временный файл в финальный JSON
  await convertTempToFinal();
  
  // Загружаем данные в кэш
  await loadLocalData();
}

client.once('ready', async () => {
  console.log(`✅ Бот ${client.user.tag} запущен!`);
  
  // Пытаемся загрузить локальные данные
  const hasLocalData = await loadLocalData();
  
  // Если локальных данных нет, сканируем API
  if (!hasLocalData) {
    await scanAllListings();
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  try {
    // Команда поиска
    if (command === 'search') {
      if (!args[0]) {
        return message.reply('❌ Укажите запрос! Пример: `!search item_name`');
      }

      if (marketCache.length === 0) {
        return message.reply('⚠️ База данных пуста. Используйте `!reload` для загрузки данных.');
      }

      const searchQuery = args.join(' ').toLowerCase();
      const loadingMsg = await message.reply('🔍 Ищу...');

      console.log(`🔍 Поиск: "${searchQuery}"`);
      console.log(`📊 Размер базы: ${marketCache.length} записей`);
      
      // Выводим первые 3 записи для отладки
      console.log('📋 Примеры записей из базы:');
      marketCache.slice(0, 3).forEach((item, i) => {
        console.log(`  ${i + 1}. title: "${item.title}", name: "${item.name}", slug: "${item.slug}"`);
      });

      let results = marketCache.filter(item => {
        const titleMatch = item?.title?.toLowerCase().includes(searchQuery);
        const nameMatch = item?.name?.toLowerCase().includes(searchQuery);
        const slugMatch = item?.slug?.toLowerCase().includes(searchQuery);
        
        if (titleMatch || nameMatch || slugMatch) {
          console.log(`✅ Найдено совпадение: title="${item.title}", name="${item.name}", slug="${item.slug}"`);
        }
        
        return titleMatch || nameMatch || slugMatch;
      });
      
      console.log(`📊 Найдено результатов: ${results.length}`);

      if (results.length === 0) {
        return loadingMsg.edit('❌ Ничего не найдено.');
      }

      // Универсальное извлечение цены
      function getPrice(item) {
        if (!item.price) return null;
        if (typeof item.price === 'number') return item.price;
        if (typeof item.price.amount === 'number') return item.price.amount;
        return null;
      }

      // Фильтруем только товары с ценой
      results = results.filter(item => getPrice(item) !== null);

      if (results.length === 0) {
        return loadingMsg.edit('❌ Найдены результаты, но у них нет цены.');
      }

      // Сортируем по цене по возрастанию
      results.sort((a, b) => getPrice(a) - getPrice(b));

      // Формируем embed
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`🔎 Найдено: ${results.length} результатов`)
        .setDescription(`Результаты по запросу: **${searchQuery}**`)
        .setTimestamp();

      // Добавляем до 10 товаров
      for (const item of results.slice(0, 10)) {
        const price = getPrice(item);
        const url = item.slug ? `https://uexcorp.space/marketplace/item/info/${item.slug}` : 'N/A';
        
        embed.addFields({
          name: `${item.title || item.name || item.slug || 'Unknown'}`,
          value: `💰 **${price.toLocaleString()}** aUEC\n🔗 [Открыть](${url})`,
          inline: false
        });
      }

      if (results.length > 10) {
        embed.setFooter({ text: `Показано 10 из ${results.length} результатов` });
      }

      return loadingMsg.edit({ content: null, embeds: [embed] });
    }

    // Команда перезагрузки данных (полная очистка и пересканирование)
    if (command === 'reload') {
      const msg = await message.reply('🔄 Начинаю полное пересканирование API... Это может занять несколько минут.');
      
      // Очищаем файлы
      try {
        if (fsSync.existsSync(DATA_FILE)) {
          await fs.unlink(DATA_FILE);
          console.log('🗑️ Старый файл данных удален');
        }
        if (fsSync.existsSync(TEMP_FILE)) {
          await fs.unlink(TEMP_FILE);
          console.log('🗑️ Временный файл удален');
        }
      } catch (err) {
        console.error('Ошибка при удалении файлов:', err.message);
      }
      
      marketCache = [];
      await scanAllListings();
      return msg.edit(`✅ Полная перезагрузка завершена! Загружено ${marketCache.length} позиций.`);
    }

    // Команда обновления данных (инкрементальное сканирование)
    if (command === 'update') {
      const msg = await message.reply('🔄 Начинаю инкрементальное обновление...');
      
      if (marketCache.length === 0) {
        return msg.edit('⚠️ База данных пуста. Используйте `!reload` для первичной загрузки.');
      }
      
      // Находим максимальный ID в текущей базе
      const maxId = Math.max(...marketCache.map(item => item.id || 0));
      console.log(`📍 Максимальный ID в базе: ${maxId}`);
      
      const startId = maxId + 1;
      const endId = maxId + 30000;
      const BATCH_SIZE = 2000; // Проверяем по 2000 ID за раз
      
      let totalFound = 0;
      let totalChecked = 0;
      let batchNumber = 1;
      
      console.log(`🚀 Сканирование от ID ${startId} до ${endId} блоками по ${BATCH_SIZE}`);
      
      // Проходим блоками по 2000 ID
      for (let batchStart = startId; batchStart <= endId; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endId);
        
        console.log(`\n📦 Блок ${batchNumber}: ID ${batchStart} - ${batchEnd}`);
        await msg.edit(`🔄 Блок ${batchNumber}/15: проверяю ID ${batchStart} - ${batchEnd}...`);
        
        // Очищаем временный файл для нового блока
        if (fsSync.existsSync(TEMP_FILE)) {
          await fs.unlink(TEMP_FILE);
        }
        
        let foundInBatch = 0;
        
        // Проверяем все ID в текущем блоке
        for (let id = batchStart; id <= batchEnd; id++) {
          console.log(`🔎 Проверяю ID: ${id}`);
          const result = await checkId(id);
          
          if (result.exists) {
            console.log(`✅ ID ${id} - НАЙДЕН!`);
            const item = { id: id, ...result.data };
            appendToTempFile(item);
            foundInBatch++;
          }
          
          totalChecked++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Сохраняем найденные записи из этого блока в основной файл
        if (foundInBatch > 0) {
          console.log(`💾 Сохраняю блок ${batchNumber}: найдено ${foundInBatch} записей`);
          await mergeNewDataToMainFile();
          totalFound += foundInBatch;
          await msg.edit(`✅ Блок ${batchNumber}/15 завершён: найдено ${foundInBatch} записей. Всего найдено: ${totalFound}`);
        } else {
          console.log(`⚠️ Блок ${batchNumber}: ничего не найдено`);
          await msg.edit(`⚠️ Блок ${batchNumber}/15 завершён: ничего не найдено. Всего найдено: ${totalFound}`);
        }
        
        batchNumber++;
        
        // Небольшая пауза между блоками
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Перезагружаем кэш
      await loadLocalData();
      
      const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Обновление завершено')
        .addFields(
          { name: 'Проверено ID', value: `${startId} - ${endId} (${totalChecked} ID)`, inline: false },
          { name: 'Проверено блоков', value: `${batchNumber - 1} блоков по 2000 ID`, inline: true },
          { name: 'Найдено новых', value: totalFound.toString(), inline: true },
          { name: 'Всего в базе', value: marketCache.length.toString(), inline: true }
        )
        .setTimestamp();
      
      return msg.edit({ content: null, embeds: [embed] });
    }

    // Команда статистики
    if (command === 'stats') {
      const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('📊 Статистика базы данных')
        .addFields(
          { name: 'Всего позиций', value: marketCache.length.toString(), inline: true },
          { name: 'Файл данных', value: DATA_FILE, inline: false }
        )
        .setTimestamp();
      
      return message.reply({ embeds: [embed] });
    }

    // Команда дедупликации
    if (command === 'dedupe') {
      const msg = await message.reply('🔄 Начинаю удаление дубликатов...');
      
      if (marketCache.length === 0) {
        return msg.edit('⚠️ База данных пуста. Нечего дедуплицировать.');
      }
      
      const originalCount = marketCache.length;
      
      // Удаляем дубликаты по ID
      const uniqueItems = {};
      for (const item of marketCache) {
        if (item.id) {
          uniqueItems[item.id] = item;
        }
      }
      
      marketCache = Object.values(uniqueItems);
      const duplicatesRemoved = originalCount - marketCache.length;
      
      // Сохраняем очищенные данные
      await saveLocalData();
      
      const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Дедупликация завершена')
        .addFields(
          { name: 'Было записей', value: originalCount.toString(), inline: true },
          { name: 'Стало записей', value: marketCache.length.toString(), inline: true },
          { name: 'Удалено дубликатов', value: duplicatesRemoved.toString(), inline: true }
        )
        .setTimestamp();
      
      return msg.edit({ content: null, embeds: [embed] });
    }
    // Команда помощи
if (command === 'help') {
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('🧭 Список команд Marketplace бота')
    .setDescription('Вот список всех доступных команд и их назначение:')
    .addFields(
      { name: '🔍 `!search <запрос>`', value: 'Ищет товары в локальной базе данных по названию, имени или slug.', inline: false },
      { name: '🔄 `!reload`', value: 'Полностью пересканирует API, удаляет старые данные и создаёт новую базу.', inline: false },
      { name: '🆕 `!update`', value: 'Проверяет новые ID после последнего найденного и добавляет новые товары.', inline: false },
      { name: '📊 `!stats`', value: 'Показывает статистику базы данных: количество товаров и путь к файлу.', inline: false },
      { name: '🧹 `!dedupe`', value: 'Удаляет дубликаты записей из базы данных по ID.', inline: false },
      { name: '🧠 `!help`', value: 'Показывает это сообщение со списком команд.', inline: false },
    )
    .setFooter({ text: 'UEX Market Bot — помощник для сканирования и поиска товаров.' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}


  } catch (error) {
    console.error('Bot Error:', error);
    message.reply('❌ Произошла ошибка при выполнении команды.');
  }
});

client.on('error', (error) => {
  console.error('Discord Client Error:', error);
});

client.login(TOKEN);