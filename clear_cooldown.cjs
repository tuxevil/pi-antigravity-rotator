const fs = require('fs');

try {
    const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    const accsToClear = ['sebastianreal@gmail.com', 'ecuadordragont@gmail.com'];
    
    for (const acc of accsToClear) {
        if (state.accounts[acc]) {
            console.log(`Before for ${acc}:`, state.accounts[acc].cooldownsByModel);
            state.accounts[acc].cooldownsByModel = {}; // clear cooldowns
            console.log(`After for ${acc}:`, state.accounts[acc].cooldownsByModel);
            
            // Also check if there's a quotaExhaustedAt
            if (state.accounts[acc].quotaExhaustedAt) {
                console.log(`Deleting quotaExhaustedAt for ${acc}`);
                delete state.accounts[acc].quotaExhaustedAt;
            }
        }
    }
    
    fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
    console.log('Successfully updated state.json');
} catch (e) {
    console.error(e);
}
