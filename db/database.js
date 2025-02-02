const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: '31.31.196.64',
    user: 'u1662596_shaurma',
    password: 'uV6kZ2mR6alL2aT5',
    database: 'u1662596_shaurma',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Добавим функцию для проверки подключения
const testConnection = async () => {
    try {
        const connection = await pool.getConnection();
        console.log('Database connection successful');
        connection.release();
        return true;
    } catch (error) {
        console.error('Database connection failed:', error);
        return false;
    }
};

// Экспортируем функцию тестирования
module.exports = {
    query: async (sql, params) => {
        try {
            const [rows] = await pool.execute(sql, params);
            return rows;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    },
    pool,
    testConnection
}; 