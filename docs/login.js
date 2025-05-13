document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    try {
        const response = await fetch('https://fahrschule-backend.up.railway.app/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            // Speichere den Token im localStorage
            localStorage.setItem('authToken', data.token);
            // Weiterleitung zum Dashboard
            window.location.href = 'dashboard.html';
        } else {
            showError(data.message || 'Login fehlgeschlagen');
        }
    } catch (error) {
        console.error('Fehler:', error);
        showError('Ein Fehler ist aufgetreten');
    }
});

function showError(message) {
    const errorDiv = document.getElementById('error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
} 