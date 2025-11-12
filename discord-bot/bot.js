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

// Загрузка токена из .env
require('dotenv').config();
const TOKEN = process.env.DISCORD_TOKEN; // Исправлено с DISCROD_API

const PREFIX = '!';
const DATA_FILE = path.join(__dirname, 'marketplace_data.json');

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
}

// -------- Загрузка с API --------

async function fetchMarketData(limit = 100000) {
  try {
    const response = await axios.get('https://api.uexcorp.space/2.0/items', {
      params: { limit },
      timeout: 30000
    });
    
    if (response.data && response.data.data) {
      marketCache = response.data.data;
      await saveLocalData();
      return marketCache.length;
    }
    return 0;
  } catch (error) {
    console.error('Ошибка загрузки:', error.message);
    throw error;
  }
}

// -------- Discord Bot --------

client.once('ready', async () => {
  console.log(`✅ Бот ${client.user.tag} запущен!`);
  await loadLocalData();
});

// ===== ФУНКЦИЯ СОЗДАНИЯ EMBED'ОВ ПО СТРАНИЦЕ =====

function getPrice(item) {
  if (!item.price) return null;
  if (typeof item.price === 'number') return item.price;
  if (typeof item.price.amount === 'number') return item.price.amount;
  return null;
}

function buildPageEmbeds(results, page, totalPages) {
  const ITEMS_PER_PAGE = 5;
  const start = page * ITEMS_PER_PAGE;
  const slice = results.slice(start, start + ITEMS_PER_PAGE);

  return slice.map(item => {
    const price = getPrice(item);
    const stock = item.in_stock || 0;
    const seller = item.user_name || 'Unknown';
    const url = item.slug ? `https://uexcorp.space/marketplace/item/info/${item.slug}` : null;

    const color = stock >= 5 ? "#00FF00" : stock >= 2 ? "#F1C40F" : "#FF0000";

    return new EmbedBuilder()
      .setColor(color)
      .setTitle(item.title || item.name || item.slug || "Товар")
      .setThumbnail(item.user_avatar || null)
      .setURL(url)
      .setDescription(
        `💰 **Цена:** ${price?.toLocaleString()} aUEC\n` +
        `📦 **В наличии:** ${stock}\n` +
        `👤 Продавец: **${seller}**`
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

// ===== Команды =====

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
          value: 'Обновить базу данных с API UEX Corp.\n' +
                 '• Загружает до 100,000 позиций\n' +
                 '• Может занять несколько секунд\n' +
                 '• Доступно только администраторам'
        },
        {
          name: '📊 !stats',
          value: 'Показать статистику базы данных.\n' +
                 '• Количество товаров\n' +
                 '• Товаров в наличии\n' +
                 '• Общая стоимость'
        },
        {
          name: '❓ !help',
          value: 'Показать это сообщение со справкой.'
        }
      )
      .addFields({
        name: '🎨 Цветовая индикация',
        value: '🟢 **Зеленый** - В наличии ≥ 5 шт.\n' +
               '🟡 **Желтый** - В наличии 2-4 шт.\n' +
               '🔴 **Красный** - В наличии 1 шт.'
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

    const loading = await message.reply('🔄 Загружаю данные с API (лимит: 100,000)...');
    
    try {
      const count = await fetchMarketData(100000);
      await loading.edit(`✅ Загружено **${count.toLocaleString()}** позиций!`);
    } catch (error) {
      await loading.edit(`❌ Ошибка загрузки: ${error.message}`);
    }
    return;
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
        { name: '💰 Общая стоимость', value: `${totalValue.toLocaleString()} aUEC`, inline: true }
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

    let results = marketCache.filter(item =>
      (item?.title?.toLowerCase().includes(query) ||
       item?.name?.toLowerCase().includes(query) ||
       item?.slug?.toLowerCase().includes(query))
      && (item.is_sold_out || 0) === 0
      && (item.in_stock || 0) >= 1
      && getPrice(item) !== null
    ).sort((a, b) => getPrice(a) - getPrice(b));

    if (!results.length) return loading.edit('❌ Ничего не найдено. Попробуйте другой запрос.');

    let page = 0;
    const totalPages = Math.ceil(results.length / 5);

    let embeds = buildPageEmbeds(results, page, totalPages);
    let msg = await loading.edit({ 
      content: `Найдено: **${results.length}** ${results.length === 1 ? 'товар' : 'товаров'}`, 
      embeds, 
      components: [pageButtons()] 
    });

    const collector = msg.createMessageComponentCollector({ time: 300000 });

    collector.on('collect', async i => {
      if (i.user.id !== message.author.id) return i.reply({ content: "❌ Не тебе.", ephemeral: true });

      if (i.customId === 'next') page = Math.min(page + 1, totalPages - 1);
      if (i.customId === 'prev') page = Math.max(page - 1, 0);
      if (i.customId === 'close') return i.message.delete().catch(() => {});

      embeds = buildPageEmbeds(results, page, totalPages);
      await i.update({ embeds, components: [pageButtons()] });
    });

    collector.on('end', () => {
      msg.edit({ components: [] }).catch(() => {});
    });
  }
});

// Запуск
client.login(TOKEN);