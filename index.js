const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('./db/database');

const token = process.env.TG_TOKEN;

const webAppUrl = 'https://jazzy-sunflower-46eab1.netlify.app/';

const bot = new TelegramBot(token, {polling: true});
const app = express();

// Добавляем конфигурацию CORS
const corsOptions = {
    origin: 'https://jazzy-sunflower-46eab1.netlify.app/', // URL вашего React приложения
    methods: ['GET', 'POST', 'DELETE', 'UPDATE', 'PUT', 'PATCH'],
    credentials: true
};

// Применяем CORS middleware
app.use(cors(corsOptions));
app.use(express.json());

// Добавим состояние для отслеживания процесса добавления товара
const userStates = {};

// Обновляем пути для работы с файлами
const dbFilePath = path.join(__dirname, 'data', 'menuDB.json');
const imagesDir = path.join(__dirname, 'images');

// Добавим структуру для хранения заказов
const ordersDB = {
    orders: []
};

// Функция для создания директории data, если её нет
function ensureDataDirectory() {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Создаем директорию для изображений, если её нет
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }
}

// Заменяем функцию loadMenuDB на получение данных из MySQL
async function loadMenuDB() {
    try {
        const products = await db.query(`
            SELECT p.*, c.slug as category
            FROM products p
            JOIN categories c ON p.category_id = c.id
        `);

        // Загружаем ингредиенты из базы
        const ingredients = await db.query('SELECT * FROM ingredients');
        console.log('Loaded ingredients from database:', ingredients);
        
        // Получаем связи продуктов с ингредиентами
        const productIngredients = await db.query(`
            SELECT pi.*, i.name, i.price 
            FROM product_ingredients pi
            JOIN ingredients i ON pi.ingredient_id = i.id
        `);

        // Формируем структуру как в JSON
        const menuDB = {
            snacks: [],
            mainMenu: [],
            drinks: [],
            sauces: [],
            ingredients: ingredients,
            currentCategory: null
        };

        // Распределяем продукты по категориям
        products.forEach(product => {
            const productIngrs = productIngredients.filter(pi => pi.product_id === product.id);
            
            const formattedProduct = {
                id: product.id,
                name: product.name,
                price: parseFloat(product.price),
                description: product.description,
                photoId: product.photo_id,
                photoUrl: product.photo_url,
                ingredients: productIngrs.filter(pi => !pi.is_removable),
                removableIngredients: productIngrs.filter(pi => pi.is_removable)
            };

            menuDB[product.category].push(formattedProduct);
        });

        return menuDB;
    } catch (error) {
        console.error('Error loading menu from database:', error);
        throw error;
    }
}

// Заменяем функцию saveMenuDB на сохранение в MySQL
async function saveMenuDB(menuData) {
    try {
        // Начинаем транзакцию
        const connection = await db.pool.getConnection();
        await connection.beginTransaction();

        try {
            // Очищаем существующие данные
            await connection.execute('DELETE FROM product_ingredients');
            await connection.execute('DELETE FROM products');

            // Сохраняем продукты по категориям
            for (const [category, products] of Object.entries(menuData)) {
                if (category !== 'currentCategory' && category !== 'ingredients') {
                    const [categoryRow] = await connection.execute(
                        'SELECT id FROM categories WHERE slug = ?',
                        [category]
                    );

                    if (categoryRow.length > 0) {
                        const categoryId = categoryRow[0].id;

                        for (const product of products) {
                            // Сохраняем продукт
                            await connection.execute(
                                `INSERT INTO products 
                                (id, name, price, description, photo_id, photo_url, category_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                [
                                    product.id,
                                    product.name,
                                    product.price,
                                    product.description,
                                    product.photoId,
                                    product.photoUrl,
                                    categoryId
                                ]
                            );

                            // Сохраняем ингредиенты продукта
                            for (const ing of product.ingredients || []) {
                                await connection.execute(
                                    `INSERT INTO product_ingredients 
                                    (product_id, ingredient_id, is_removable)
                                    VALUES (?, ?, false)`,
                                    [product.id, ing.id]
                                );
                            }

                            // Сохраняем удаляемые ингредиенты
                            for (const ing of product.removableIngredients || []) {
                                await connection.execute(
                                    `INSERT INTO product_ingredients 
                                    (product_id, ingredient_id, is_removable)
                                    VALUES (?, ?, true)`,
                                    [product.id, ing.id]
                                );
                            }
                        }
                    }
                }
            }

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error saving menu to database:', error);
        throw error;
    }
}

// Обновляем путь для сохранения заказов
function saveOrders() {
    try {
        fs.writeFileSync(
            path.join(__dirname, 'data', 'orders.json'),
            JSON.stringify(ordersDB, null, 2)
        );
    } catch (error) {
        console.error('Error saving orders:', error);
    }
}

// Добавляем логирование при старте сервера
console.log('Server starting...');
console.log('Current directory:', __dirname);
console.log('DB file path:', dbFilePath);

// Добавим проверку подключения к базе при старте
db.testConnection().then(isConnected => {
    if (isConnected) {
        console.log('Successfully connected to database');
    } else {
        console.error('Failed to connect to database');
        process.exit(1);
    }
});

// Инициализируем menuDB из файла
const menuDB = loadMenuDB();
console.log('Initialized menuDB:', menuDB);

// Загрузка заказов при старте
try {
    const ordersData = fs.readFileSync(path.join(__dirname, 'data', 'orders.json'));
    Object.assign(ordersDB, JSON.parse(ordersData));
} catch (error) {
    console.log('No existing orders found');
}

// Добавляем базовую структуру рецепта
const defaultRecipe = {
    ingredients: [],
    steps: [],
    cookingTime: '',
    servingSize: ''
};

// Добавляем базовые ингредиенты и их стоимость
const ingredients = {
    cheese: { name: 'Сыр', price: 40 },
    jalapeno: { name: 'Халапеньо', price: 40 },
    bacon: { name: 'Бекон', price: 40 },
    spicySauce: { name: 'Острый соус', price: 0 }
};

// Добавляем названия категорий для статистики
const categoryNames = {
    snacks: 'Снеки',
    mainMenu: 'Основное меню',
    drinks: 'Напитки',
    sauces: 'Соусы'
};

// Создаем папку для изображений в tg-web-app-react-master, если её нет
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir);
}

// Функция для сохранения изображения
async function downloadImage(fileUrl, fileName) {
    const imagePath = path.join(imagesDir, fileName);
    const writer = fs.createWriteStream(imagePath);

    console.log(`Downloading image from ${fileUrl} to ${imagePath}`);

    const response = await axios({
        url: fileUrl,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            console.log(`Image saved to ${imagePath}`);
            resolve();
        });
        writer.on('error', (error) => {
            console.error('Error saving image:', error);
            reject(error);
        });
    });
}

// Обработка команды для просмотра меню
bot.onText(/\/menu/, async (msg) => {
    const chatId = msg.chat.id;
    let menuText = 'Текущее меню:\n\n';
    
    // Добавляем информацию о возможности убрать лук
    menuText += '🔸 Особенности:\n';
    menuText += '- Для Гамбургера, Шаурмы на тарелке и Сендвича доступна опция "Убрать лук"\n\n';
    
    // Формируем текст меню по категориям
    for (const [category, items] of Object.entries(menuDB)) {
        if (category !== 'currentCategory' && items.length > 0) {
            menuText += `${categoryNames[category]}:\n`;
            items.forEach(item => {
                menuText += `- ${item.name}: ${item.price}₽\n`;
                if (item.description) menuText += `  ${item.description}\n`;
                // Добавляем пометку о возможности убрать лук
                if (['Гамбургер', 'Шаурма на тарелке', 'Сендвич'].includes(item.name)) {
                    menuText += '  ⚡️ Можно без лука\n';
                }
            });
            menuText += '\n';
        }
    }
    
    await bot.sendMessage(chatId, menuText);
});

// Команда для вызова админ-меню
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.id === Number(process.env.ADMIN_ID)) {
        await bot.sendMessage(chatId, 'Админ-панель:', {
            reply_markup: {
                inline_keyboard: [
                    [{text: '➕ Добавить товар', callback_data: 'admin_add'}],
                    [{text: '❌ Удалить товар', callback_data: 'admin_remove'}],
                    [{text: '📋 Просмотр меню', callback_data: 'admin_menu'}],
                    [{text: '📊 Статистика', callback_data: 'admin_stats'}]
                ]
            }
        });
    } else {
        await bot.sendMessage(chatId, 'У вас нет прав администратора');
    }
});

// Обновляем обработку колбэков
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    
    switch(query.data) {
        case 'admin_add':
            userStates[chatId] = { state: 'AWAITING_CATEGORY' };
            await bot.sendMessage(chatId, 'Выберите категорию для добавления:', {
                reply_markup: {
                    inline_keyboard: [
                        [{text: '🍟 Снеки', callback_data: 'add_product_snacks'}],
                        [{text: '🍔 Основное меню', callback_data: 'add_product_mainMenu'}],
                        [{text: '🥤 Напитки', callback_data: 'add_product_drinks'}],
                        [{text: '🥫 Соусы', callback_data: 'add_product_sauces'}],
                        [{text: '◀️ Назад', callback_data: 'admin_back'}]
                    ]
                }
            });
            break;

        case 'admin_remove':
            const keyboard = [];
            // Формируем клавиатуру из всех товаров
            for (const [category, items] of Object.entries(menuDB)) {
                if (category !== 'currentCategory' && items.length > 0) {
                    keyboard.push([{text: `📑 ${category.toUpperCase()}`, callback_data: `list_${category}`}]);
                }
            }
            keyboard.push([{text: '◀️ Назад', callback_data: 'admin_back'}]);
            
            await bot.sendMessage(chatId, 'Выберите категорию:', {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            break;

        case 'admin_menu':
            let menuText = '📋 Текущее меню:\n\n';
            for (const [category, items] of Object.entries(menuDB)) {
                if (category !== 'currentCategory' && items.length > 0) {
                    menuText += `${category.toUpperCase()}:\n`;
                    items.forEach(item => {
                        menuText += `- ${item.name}: ${item.price}₽\n`;
                        if (item.description) menuText += `  ${item.description}\n`;
                    });
                    menuText += '\n';
                }
            }
            await bot.sendMessage(chatId, menuText, {
                reply_markup: {
                    inline_keyboard: [[{text: '◀️ Назад', callback_data: 'admin_back'}]]
                }
            });
            break;

        case 'admin_stats':
            const stats = {
                total: Object.entries(menuDB)
                    .filter(([key]) => ['snacks', 'mainMenu', 'drinks', 'sauces'].includes(key))
                    .reduce((sum, [_, items]) => sum + items.length, 0),
                byCategory: Object.entries(menuDB)
                    .filter(([key]) => ['snacks', 'mainMenu', 'drinks', 'sauces'].includes(key))
                    .map(([key, items]) => `${categoryNames[key]}: ${items.length}`)
                    .join('\n')
            };
            
            await bot.sendMessage(chatId, 
                `📊 Статистика:\n\nВсего товаров: ${stats.total}\n\nПо категориям:\n${stats.byCategory}`, {
                reply_markup: {
                    inline_keyboard: [[{text: '◀️ Назад', callback_data: 'admin_back'}]]
                }
            });
            break;

        case 'admin_back':
            await bot.sendMessage(chatId, 'Админ-панель:', {
                reply_markup: {
                    inline_keyboard: [
                        [{text: '➕ Добавить товар', callback_data: 'admin_add'}],
                        [{text: '❌ Удалить товар', callback_data: 'admin_remove'}],
                        [{text: '📋 Просмотр меню', callback_data: 'admin_menu'}],
                        [{text: '🧂 Управление ингредиентами', callback_data: 'admin_ingredients'}],
                        [{text: '📊 Статистика', callback_data: 'admin_stats'}]
                    ]
                }
            });
            break;

        // Обработка добавления товара
        case (query.data.match(/^add_product_/) || {}).input:
            const category = query.data.split('_')[2];
            userStates[chatId] = {
                state: 'AWAITING_ITEM_DATA',
                category: category
            };
            
            await bot.sendMessage(chatId, 
                '📝 Отправьте данные о товаре в формате:\n\n' +
                'Название\n' +
                'Цена\n' +
                'Описание\n\n' +
                'После этого отправьте фото товара'
            );
            break;

        // Обработка списка товаров для удаления
        case (query.data.match(/^list_/) || {}).input:
            const listCategory = query.data.split('_')[1];
            const items = menuDB[listCategory];
            const itemKeyboard = items.map(item => [{
                text: item.name,
                callback_data: `remove_${listCategory}_${item.name}`
            }]);
            itemKeyboard.push([{text: '◀️ Назад', callback_data: 'admin_remove'}]);
            
            await bot.sendMessage(chatId, `Выберите товар для удаления из категории ${listCategory}:`, {
                reply_markup: {
                    inline_keyboard: itemKeyboard
                }
            });
            break;

        // Обработка удаления товара
        case (query.data.match(/^remove_/) || {}).input:
            const [_, removeCategory, ...nameParts] = query.data.split('_');
            const itemName = nameParts.join('_');
            
            menuDB[removeCategory] = menuDB[removeCategory].filter(item => item.name !== itemName);
            saveMenuDB(menuDB); // Сохраняем изменения
            
            await bot.sendMessage(chatId, `✅ Товар ${itemName} успешно удален из категории ${removeCategory}`, {
                reply_markup: {
                    inline_keyboard: [[{text: '◀️ Назад', callback_data: 'admin_remove'}]]
                }
            });
            break;

        // Добавляем новые обработчики для ингредиентов
        case 'admin_ingredients':
            await bot.sendMessage(chatId, 'Управление ингредиентами:', {
                reply_markup: {
                    inline_keyboard: [
                        [{text: '➕ Добавить ингредиент', callback_data: 'add_ingredient'}],
                        [{text: '❌ Удалить ингредиент', callback_data: 'remove_ingredient'}],
                        [{text: '📋 Список ингредиентов', callback_data: 'list_ingredients'}],
                        [{text: '◀️ Назад', callback_data: 'admin_back'}]
                    ]
                }
            });
            break;

        case 'add_ingredient':
            userStates[chatId] = { state: 'AWAITING_INGREDIENT_DATA' };
            await bot.sendMessage(chatId, 
                '📝 Отправьте данные ингредиента в формате:\n\n' +
                'Название\n' +
                'Цена\n\n' +
                'Например:\n' +
                'Сыр\n' +
                '40'
            );
            break;

        case 'list_ingredients':
            let ingredientsList = '📋 Список доступных ингредиентов:\n\n';
            menuDB.ingredients.forEach(ing => {
                ingredientsList += `- ${ing.name}: ${ing.price}₽\n`;
            });
            await bot.sendMessage(chatId, ingredientsList || 'Список ингредиентов пуст', {
                reply_markup: {
                    inline_keyboard: [[{text: '◀️ Назад', callback_data: 'admin_ingredients'}]]
                }
            });
            break;

        case 'remove_ingredient':
            const ingredientKeyboard = menuDB.ingredients.map(ing => [{
                text: `${ing.name} (${ing.price}₽)`,
                callback_data: `delete_ingredient_${ing.id}`
            }]);
            ingredientKeyboard.push([{text: '◀️ Назад', callback_data: 'admin_ingredients'}]);
            
            await bot.sendMessage(chatId, 'Выберите ингредиент для удаления:', {
                reply_markup: {
                    inline_keyboard: ingredientKeyboard
                }
            });
            break;

        // Обработка удаления ингредиента
        case (query.data.match(/^delete_ingredient_/) || {}).input:
            const ingredientId = query.data.split('_')[2];
            try {
                // Удаляем из базы данных
                await db.query('DELETE FROM ingredients WHERE id = ?', [ingredientId]);
                
                // Удаляем из menuDB
                menuDB.ingredients = menuDB.ingredients.filter(ing => ing.id !== ingredientId);
                
                await bot.sendMessage(chatId, 'Ингредиент успешно удален!', {
                    reply_markup: {
                        inline_keyboard: [[{text: '◀️ Назад', callback_data: 'admin_ingredients'}]]
                    }
                });
            } catch (error) {
                console.error('Error deleting ingredient:', error);
                await bot.sendMessage(chatId, 'Ошибка при удалении ингредиента.');
            }
            break;

        // Добавим обработку действий с заказом
        case (query.data.startsWith('accept_order_') || {}).input:
            const orderId = Number(query.data.split('_')[2]);
            const order = ordersDB.orders.find(o => o.id === orderId);
            if (order) {
                order.status = 'accepted';
                saveOrders();
                await bot.sendMessage(order.userId, `✅ Ваш заказ #${orderId} принят и готовится!`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            }
            break;

        case (query.data.startsWith('reject_order_') || {}).input:
            const rejectOrderId = Number(query.data.split('_')[2]);
            const rejectOrder = ordersDB.orders.find(o => o.id === rejectOrderId);
            if (rejectOrder) {
                rejectOrder.status = 'rejected';
                saveOrders();
                await bot.sendMessage(rejectOrder.userId, `❌ К сожалению, ваш заказ #${rejectOrderId} отклонен.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            }
            break;
    }
});

app.use(express.json());
app.use(cors());

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const state = userStates[chatId];
    const isAdmin = chatId === Number(process.env.ADMIN_ID);

    if(text === '/start') {
        // Базовые кнопки для всех пользователей
        const baseKeyboard = [
            [{text: 'Заполнить форму', web_app: {url: webAppUrl + '/form'}}]
        ];

        // Добавляем админские кнопки, если это админ
        if (isAdmin) {
            baseKeyboard.push(
                [{text: '⚙️ Админ-панель'}],
                [{text: '📊 Статистика'}],
                [{text: '➕ Добавить товар'}],
                [{text: '❌ Удалить товар'}]
            );
        }

        await bot.sendMessage(chatId, 'Выберите действие:', {
            reply_markup: {
                keyboard: baseKeyboard,
                resize_keyboard: true
            }
        });

        await bot.sendMessage(chatId, 'Заходи в наш интернет магазин по кнопке ниже', {
            reply_markup: {
                inline_keyboard: [
                    [{text: 'Сделать заказ', web_app: {url: webAppUrl}}]
                ]
            }
        });
    }

    // Обработка админских кнопок
    if (isAdmin) {
        switch(text) {
            case '⚙️ Админ-панель':
                await bot.sendMessage(chatId, 'Админ-панель:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{text: '➕ Добавить товар', callback_data: 'admin_add'}],
                            [{text: '❌ Удалить товар', callback_data: 'admin_remove'}],
                            [{text: '📋 Просмотр меню', callback_data: 'admin_menu'}],
                            [{text: '🧂 Управление ингредиентами', callback_data: 'admin_ingredients'}],
                            [{text: '📊 Статистика', callback_data: 'admin_stats'}]
                        ]
                    }
                });
                break;

            case '📊 Статистика':
                const statsData = {
                    total: Object.entries(menuDB)
                        .filter(([key]) => ['snacks', 'mainMenu', 'drinks', 'sauces'].includes(key))
                        .reduce((sum, [_, items]) => sum + items.length, 0),
                    byCategory: Object.entries(menuDB)
                        .filter(([key]) => ['snacks', 'mainMenu', 'drinks', 'sauces'].includes(key))
                        .map(([key, items]) => `${categoryNames[key]}: ${items.length}`)
                        .join('\n')
                };
                
                await bot.sendMessage(chatId, 
                    `📊 Статистика:\n\nВсего товаров: ${statsData.total}\n\nПо категориям:\n${statsData.byCategory}`
                );
                break;

            case '➕ Добавить товар':
                userStates[chatId] = { state: 'AWAITING_CATEGORY' };
                await bot.sendMessage(chatId, 'Выберите категорию для добавления:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{text: '🍟 Снеки', callback_data: 'add_product_snacks'}],
                            [{text: '🍔 Основное меню', callback_data: 'add_product_mainMenu'}],
                            [{text: '🥤 Напитки', callback_data: 'add_product_drinks'}],
                            [{text: '🥫 Соусы', callback_data: 'add_product_sauces'}]
                        ]
                    }
                });
                break;

            case '❌ Удалить товар':
                const keyboard = [];
                for (const [category, items] of Object.entries(menuDB)) {
                    if (category !== 'currentCategory' && items.length > 0) {
                        keyboard.push([{text: `📑 ${category.toUpperCase()}`, callback_data: `list_${category}`}]);
                    }
                }
                
                await bot.sendMessage(chatId, 'Выберите категорию:', {
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                });
                break;
        }
    }

    if(msg?.web_app_data?.data) {
        try {
            const data = JSON.parse(msg?.web_app_data?.data)
            console.log(data)
            await bot.sendMessage(chatId, 'Спасибо за обратную связь!')
            await bot.sendMessage(chatId, 'Ваша страна: ' + data?.country);
            await bot.sendMessage(chatId, 'Ваша улица: ' + data?.street);

            setTimeout(async () => {
                await bot.sendMessage(chatId, 'Всю информацию вы получите в этом чате');
            }, 3000)
        } catch (e) {
            console.log(e);
        }
    }

    // Обработка добавления товара
    if (state && state.state === 'AWAITING_ITEM_DATA' && text) {
        try {
            const [name, price, description] = text.split('\n');
            
            userStates[chatId] = {
                ...state,
                state: 'AWAITING_PHOTO',
                itemData: {
                    name,
                    price: Number(price),
                    description,
                    // Используем сохраненные ингредиенты или пустой массив
                    ingredients: Array.isArray(menuDB.ingredients) ? [...menuDB.ingredients] : [],
                    removableIngredients: []
                }
            };

            // Для определенных блюд добавляем возможность убрать лук
            if (['Гамбургер', 'Шаурма на тарелке', 'Сендвич'].includes(name)) {
                userStates[chatId].itemData.removableIngredients = [
                    { id: 'onion', name: 'Лук' }
                ];
            }

            await bot.sendMessage(chatId, 'Теперь отправьте фото товара');
        } catch (e) {
            console.error(e);
            await bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
        }
    }

    // Функция для сохранения ингредиента в базу данных
    async function saveIngredient(ingredient) {
        try {
            await db.query(
                `INSERT INTO ingredients (id, name, price) 
                 VALUES (?, ?, ?)`,
                [ingredient.id, ingredient.name, ingredient.price]
            );
            console.log('Ingredient saved to database:', ingredient);
            return true;
        } catch (error) {
            console.error('Error saving ingredient to database:', error);
            return false;
        }
    }

    // Обработка добавления ингредиента
    if (state && state.state === 'AWAITING_INGREDIENT_DATA' && text) {
        try {
            const [name, price] = text.split('\n');
            if (!name || !price || isNaN(Number(price))) {
                await bot.sendMessage(chatId, 'Неверный формат. Попробуйте снова.');
                return;
            }

            const newIngredient = {
                id: Date.now().toString(),
                name: name.trim(),
                price: Number(price)
            };

            // Сохраняем в базу данных
            const saved = await saveIngredient(newIngredient);
            
            if (saved) {
                // Обновляем menuDB только после успешного сохранения в базу
                if (!menuDB.ingredients) {
                    menuDB.ingredients = [];
                }
                menuDB.ingredients.push(newIngredient);
                
                console.log('Added ingredient:', newIngredient);
                console.log('Current ingredients:', menuDB.ingredients);

                await bot.sendMessage(chatId, `✅ Ингредиент "${name}" успешно добавлен!`, {
                    reply_markup: {
                        inline_keyboard: [[{text: '◀️ Назад', callback_data: 'admin_ingredients'}]]
                    }
                });
            } else {
                await bot.sendMessage(chatId, 'Ошибка при сохранении ингредиента.');
            }
            
            delete userStates[chatId];
        } catch (e) {
            console.error('Error adding ingredient:', e);
            await bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
        }
    }
});

// В обработчике фото обновляем сохранение
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId];

    if (state && state.state === 'AWAITING_PHOTO') {
        try {
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;
            const fileInfo = await bot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
            
            // Генерируем уникальное имя файла
            const fileName = `${Date.now()}_${fileId}.jpg`;
            await downloadImage(fileUrl, fileName);

            const itemData = {
                ...state.itemData,
                id: Date.now(),
                photoId: fileId,
                photoUrl: `http://localhost:8000/images/${fileName}` // Используем локальный путь
            };

            // Добавляем возможность убрать лук для определенных блюд
            const removableLukDishes = ['Гамбургер', 'Шаурма на тарелке', 'Сендвич'];
            if (removableLukDishes.includes(itemData.name.trim())) {
                itemData.removableIngredients = [
                    { id: 'onion', name: 'Лук' }
                ];
                console.log(`Added removable onion for ${itemData.name}`);
            }

            // Проверяем существование категории
            if (!menuDB[state.category]) {
                menuDB[state.category] = [];
            }

            menuDB[state.category].push(itemData);
            saveMenuDB(menuDB); // Сохраняем изменения

            console.log('Added item with ingredients:', itemData);

            await bot.sendMessage(chatId, 'Товар успешно добавлен!');
            delete userStates[chatId];
        } catch (e) {
            console.error('Error adding product:', e);
            await bot.sendMessage(chatId, 'Произошла ошибка при добавлении товара.');
        }
    }
});

app.post('/web-data', async (req, res) => {
    console.log('Received order data:', req.body);
    const { products, totalPrice, deliveryType, phone, address, userId } = req.body;
    
    try {
        // Проверяем наличие всех необходимых данных
        if (!userId) {
            console.error('Missing userId in request');
            return res.status(400).json({ error: 'Missing userId' });
        }

        if (!products || !products.length) {
            console.error('No products in order');
            return res.status(400).json({ error: 'No products in order' });
        }

        // Создаем новый заказ
        const order = {
            id: Date.now(),
            userId,
            products,
            totalPrice,
            deliveryType,
            phone,
            address,
            status: 'new',
            createdAt: new Date().toISOString()
        };

        // Сохраняем заказ
        ordersDB.orders.push(order);
        saveOrders();

        // Формируем сообщение для клиента
        const orderDetails = products.map(item => {
            let text = `${item.name} - ${item.finalPrice}₽ x ${item.quantity || 1}`;
            if (item.addedIngredients?.length > 0) {
                text += `\nДополнительно: ${item.addedIngredients.map(i => i.name).join(', ')}`;
            }
            if (item.removedIngredients?.length > 0) {
                text += `\nУбрано: ${item.removedIngredients.map(i => i.name).join(', ')}`;
            }
            return text;
        }).join('\n\n');

        const deliveryInfo = deliveryType === 'delivery' 
            ? `\nДоставка по адресу: ${address}`
            : '\nСамовывоз';

        const clientMessage = `
🎉 Заказ #${order.id} принят!

📋 Ваш заказ:
${orderDetails}

💰 Итого: ${totalPrice}₽
${deliveryInfo}

📞 Телефон: ${phone}
`;
        
        // Добавим логирование перед отправкой сообщений
        console.log('Sending message to user:', userId);
        console.log('Client message:', clientMessage);
        
        try {
            await bot.sendMessage(userId, clientMessage);
            console.log('Client message sent successfully');
        } catch (error) {
            console.error('Error sending client message:', error);
        }

        // Отправляем уведомление админу
        const adminMessage = `
🔔 Новый заказ #${order.id}!

👤 Клиент: ${userId}
📞 Телефон: ${phone}
🚚 Тип доставки: ${deliveryType === 'delivery' ? 'Доставка' : 'Самовывоз'}
${address ? `📍 Адрес: ${address}` : ''}

📋 Заказ:
${orderDetails}

💰 Итого: ${totalPrice}₽
`;

        try {
            await bot.sendMessage(process.env.ADMIN_ID, adminMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Принять', callback_data: `accept_order_${order.id}` },
                            { text: '❌ Отклонить', callback_data: `reject_order_${order.id}` }
                        ]
                    ]
                }
            });
            console.log('Admin message sent successfully');
        } catch (error) {
            console.error('Error sending admin message:', error);
        }

        res.status(200).json({ orderId: order.id });
    } catch (e) {
        console.error('Error processing order:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Получение продуктов
app.get('/api/products', async (req, res) => {
    try {
        const menuDB = await loadMenuDB();
        console.log('Sending products to client:', menuDB); // Добавим для отладки
        res.json({
            snacks: menuDB.snacks || [],
            mainMenu: menuDB.mainMenu || [],
            drinks: menuDB.drinks || [],
            sauces: menuDB.sauces || []
        });
    } catch (error) {
        console.error('Error getting products:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// Добавление продукта
app.post('/api/products', async (req, res) => {
    try {
        const { category, name, price, description, photoUrl, photoId } = req.body;
        
        const [categoryRow] = await db.query(
            'SELECT id FROM categories WHERE slug = ?',
            [category]
        );

        if (categoryRow.length === 0) {
            return res.status(400).json({ error: 'Invalid category' });
        }

        const productId = Date.now();
        await db.query(
            `INSERT INTO products 
            (id, name, price, description, photo_id, photo_url, category_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [productId, name, price, description, photoId, photoUrl, categoryRow[0].id]
        );

        res.status(201).json({
            id: productId,
            name,
            price,
            description,
            photoUrl,
            photoId,
            category
        });
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Удаление продукта
app.delete('/api/products/:category/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await db.query('DELETE FROM product_ingredients WHERE product_id = ?', [id]);
        await db.query('DELETE FROM products WHERE id = ?', [id]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Добавляем раздачу статических файлов с нового пути
app.use('/images', express.static(imagesDir));

// Добавляем автоматическое сохранение каждые 5 минут
setInterval(() => {
    saveMenuDB(menuDB);
}, 5 * 60 * 1000);

// В начале файла после создания бота
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Добавьте команду для проверки
bot.onText(/\/test/, async (msg) => {
    try {
        await bot.sendMessage(msg.chat.id, 'Test message');
        console.log('Test message sent successfully');
    } catch (error) {
        console.error('Error sending test message:', error);
    }
});

// Добавьте в начало файла после require('dotenv').config();
if (!process.env.TG_TOKEN) {
    console.error('ERROR: TG_TOKEN is not set in .env file');
    process.exit(1);
}

if (!process.env.ADMIN_ID) {
    console.error('ERROR: ADMIN_ID is not set in .env file');
    process.exit(1);
}

console.log('Bot configuration loaded successfully');
console.log('Admin ID:', process.env.ADMIN_ID);

// Обновляем порт из .env
const PORT = process.env.PORT || 8000;

// Добавляем логирование при запуске сервера
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('CORS enabled for:', corsOptions.origin);
});