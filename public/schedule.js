let calendar;
let scheduledCalls = [];

// Initialize calendar
document.addEventListener('DOMContentLoaded', function() {
    const calendarEl = document.getElementById('calendar');
    
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,callLog'
        },
        views: {
        callLog: {
            type: 'listWeek',
            buttonText: 'call log'
        }
        },
        height: 'auto',
        events: [],
        eventClick: function(info) {
            alert(`Scheduled Call\nPhone: ${info.event.extendedProps.phone}\nFrequency: ${info.event.extendedProps.frequency}\nTime: ${info.event.extendedProps.time}`);
        }
    });
    
    calendar.render();
    loadScheduledCalls();
});

// Load scheduled calls from server
async function loadScheduledCalls() {
    try {
        const response = await fetch('/scheduled-calls');
        const data = await response.json();
        scheduledCalls = data.calls || [];
        
        updateStats();
        updateCalendar();
        updateCallsList();
    } catch (error) {
        console.error('Error loading scheduled calls:', error);
    }
}

// Update stats cards
function updateStats() {
    const dailyCalls = scheduledCalls.filter(c => c.frequency === 'daily').length;
    const weeklyCalls = scheduledCalls.filter(c => c.frequency === 'weekly').length;
    
    document.getElementById('total-calls').textContent = scheduledCalls.length;
    document.getElementById('daily-calls').textContent = dailyCalls;
    document.getElementById('weekly-calls').textContent = weeklyCalls;
}

// Update calendar with events
async function updateCalendar() {
    try {
        // Fetch future calls from backend
        const response = await fetch('/future-calls');
        const data = await response.json();
        
        // Convert to FullCalendar events
        const events = data.calls.map(call => ({
            title: `📞 ${call.phoneNumber}`,
            start: call.scheduledTime,
            backgroundColor: call.frequency === 'daily' ? '#5B9AAD' : '#4a7a8a',
            borderColor: call.frequency === 'daily' ? '#5B9AAD' : '#4a7a8a',
            extendedProps: {
                phone: call.phoneNumber,
                frequency: call.frequency
            }
        }));
        
        calendar.removeAllEvents();
        calendar.addEventSource(events);
    } catch (error) {
        console.error('Error loading future calls:', error);
    }
}

// Update calls list
function updateCallsList() {
    const container = document.getElementById('calls-container');
    
    if (scheduledCalls.length === 0) {
        container.innerHTML = '<div class="no-calls">No scheduled calls yet</div>';
        return;
    }

    container.innerHTML = scheduledCalls.map(call => `
        <div class="call-item">
            <div class="call-info">
                <div class="phone">${call.phoneNumber}</div>
                <div class="schedule">${call.frequency.charAt(0).toUpperCase() + call.frequency.slice(1)} at ${call.time}</div>
            </div>
            <div class="call-badge">${call.frequency}</div>
        </div>
    `).join('');
}


// Refresh every 30 seconds
setInterval(loadScheduledCalls, 30000);
