let calendar;
let scheduledCalls = [];
const phoneInput = document.getElementById('phoneNumber');
const frequencyInput = document.getElementById('frequency');
const scheduleCallButton = document.getElementById('scheduleCallButton');
const displayScheduledCalls = document.getElementById('displayScheduledCalls');
const scheduledCallsList = document.getElementById('scheduledCallsList');

// Initialize calendar
document.addEventListener('DOMContentLoaded', function() {
    const calendarEl = document.getElementById('calendar');
    
    if (!calendarEl) {
        console.error('Calendar element not found!');
        return;
    }
    
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
                buttonText: 'upcoming calls'
            }
        },
        height: 'auto',
        events: [],
        eventClick: function(info) {
            alert(`Scheduled Call\nTime: ${info.event.extendedProps.timeInput}\nPhone: ${info.event.extendedProps.phone}\nFrequency: ${info.event.extendedProps.frequency}`);
        }
    });
    
    calendar.render();
    loadScheduledCalls();
});

// Load scheduled calls from server (works for both AI and manual schedules)
async function loadScheduledCalls() {
    try {
        const response = await fetch('/scheduled-calls');
        const data = await response.json();
        scheduledCalls = data.calls || [];
        
        console.log(`Loaded ${scheduledCalls.length} scheduled calls`);
        
        updateStats();
        updateCalendar();
        updateCallsList();
    } catch (error) {
        console.error('Error loading scheduled calls:', error);
    }
}

// Update stats cards
function updateStats() {
    const totalEl = document.getElementById('total-calls');
    const dailyEl = document.getElementById('daily-calls');
    const weeklyEl = document.getElementById('weekly-calls');
    
    if (!totalEl) return;
    
    const dailyCalls = scheduledCalls.filter(c => c.frequency === 'daily').length;
    const weeklyCalls = scheduledCalls.filter(c => c.frequency === 'weekly').length;
    
    totalEl.textContent = scheduledCalls.length;
    dailyEl.textContent = dailyCalls;
    weeklyEl.textContent = weeklyCalls;
}

// Generate future calls from a schedule rule (client-side calculation)
function getFutureCalls(schedule, limit = 30) {
    const calls = [];
    const [hours, minutes] = schedule.time.split(':');
    const now = new Date();
    const endDate = schedule.endDate ? new Date(schedule.endDate) : null;
    
    let currentDate = new Date();
    currentDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    // If today's call time has passed, start from tomorrow
    if (currentDate <= now) {
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    while (calls.length < limit) {
        if (endDate && currentDate > endDate) break;
        
        // For weekly, only include Mondays
        if (schedule.frequency === 'weekly' && currentDate.getDay() !== 1) {
            currentDate.setDate(currentDate.getDate() + 1);
            continue;
        }
        
        calls.push({
            phoneNumber: schedule.phoneNumber,
            scheduledTime: new Date(currentDate).toISOString(),
            frequency: schedule.frequency,
            scheduleId: schedule.id
        });
        
        // Move to next occurrence
        if (schedule.frequency === 'daily') {
            currentDate.setDate(currentDate.getDate() + 1);
        } else if (schedule.frequency === 'weekly') {
            currentDate.setDate(currentDate.getDate() + 7);
        }
    }
    
    return calls;
}

// Update calendar with events (generates from schedule rules in real-time)
function updateCalendar() {
    if (!calendar) {
        console.error('Calendar not initialized');
        return;
    }

    try {
        // Generate all future calls from all schedule rules
        const allFutureCalls = [];
        
        scheduledCalls.forEach(schedule => {
            const futureCalls = getFutureCalls(schedule, 30);
            allFutureCalls.push(...futureCalls);
        });
        
        console.log(`Generated ${allFutureCalls.length} future calls for calendar`);
        
        // Convert to FullCalendar events
        const events = allFutureCalls.map(call => ({
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
        console.error('Error updating calendar:', error);
    }
}

// Update calls list (schedule rules)
function updateCallsList() {
    const container = document.getElementById('calls-container');
    
    if (!container) return;
    
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

// Refresh every 30 seconds (picks up new AI-scheduled calls)
setInterval(loadScheduledCalls, 30000);

// Test scheduler event listeners (for manual testing)
document.addEventListener('DOMContentLoaded', function() {
    const scheduleCallButton = document.getElementById('scheduleCallButton');
    const displayScheduledCalls = document.getElementById('displayScheduledCalls');
    const scheduledCallsList = document.getElementById('scheduledCallsList');
    const statusDiv = document.getElementById('status');
    
    // Only set up if elements exist (form may not be on all pages)
    if (scheduleCallButton) {
        console.log('Test scheduler found, initializing...');
        
        const phoneInput = document.getElementById('phoneNumber');
        const frequencyInput = document.getElementById('frequency');
        const timeInput = document.getElementById('time');
        
        // Schedule button
        scheduleCallButton.addEventListener('click', async () => {
            console.log('Schedule button clicked!');
            
            const phoneNumber = phoneInput.value.trim();
            const frequency = frequencyInput.value;
            const time = timeInput.value || 'undefined';
            
            console.log('Values:', { phoneNumber, frequency, time });
            
            if (!phoneNumber) {
                alert('Please enter phone number');
                return;
            }
            
            if (!frequency) {
                alert('Please select frequency');
                return;
            }
            
            try {
                const response = await fetch('/schedule-recurring', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        phoneNumber, 
                        frequency, 
                        time,
                        endDate: null  // Optional: add endDate input if needed
                    })
                });
                
                const data = await response.json();
                console.log('Response:', data);
                
                if (response.ok) {
                    statusDiv.textContent = '✅ ' + data.message;
                    statusDiv.style.background = '#d4edda';
                    statusDiv.style.color = '#155724';
                    statusDiv.style.padding = '15px';
                    statusDiv.style.borderRadius = '10px';
                    statusDiv.style.marginTop = '15px';
                    
                    // Reload calendar
                    loadScheduledCalls();
                } else {
                    statusDiv.textContent = '❌ ' + data.error;
                    statusDiv.style.background = '#f8d7da';
                    statusDiv.style.color = '#721c24';
                    statusDiv.style.padding = '15px';
                    statusDiv.style.borderRadius = '10px';
                    statusDiv.style.marginTop = '15px';
                }
            } catch (error) {
                console.error('Error:', error);
                statusDiv.textContent = '❌ Failed: ' + error.message;
                statusDiv.style.background = '#f8d7da';
                statusDiv.style.color = '#721c24';
                statusDiv.style.padding = '15px';
                statusDiv.style.borderRadius = '10px';
                statusDiv.style.marginTop = '15px';
            }
        });

        // Display button
        if (displayScheduledCalls && scheduledCallsList) {
            displayScheduledCalls.addEventListener('click', async () => {
                console.log('Loading scheduled calls table...');
                
                try {
                    const response = await fetch('/scheduled-calls');
                    const data = await response.json();
                    console.log('Scheduled calls:', data);
                    
                    if (data.calls.length === 0) {
                        scheduledCallsList.innerHTML = '<p>No scheduled calls</p>';
                        return;
                    }
                    
                    let html = '<table style="width:100%; margin-top:20px; border-collapse:collapse;"><tr><th style="border:1px solid #ddd; padding:12px; background:#5B9AAD; color:white;">ID</th><th style="border:1px solid #ddd; padding:12px; background:#5B9AAD; color:white;">Phone</th><th style="border:1px solid #ddd; padding:12px; background:#5B9AAD; color:white;">Frequency</th><th style="border:1px solid #ddd; padding:12px; background:#5B9AAD; color:white;">Time</th></tr>';
                    data.calls.forEach(call => {
                        html += `<tr>
                            <td style="border:1px solid #ddd; padding:12px;">${call.id}</td>
                            <td style="border:1px solid #ddd; padding:12px;">${call.phoneNumber}</td>
                            <td style="border:1px solid #ddd; padding:12px;">${call.frequency}</td>
                            <td style="border:1px solid #ddd; padding:12px;">${call.time}</td>
                        </tr>`;
                    });
                    html += '</table>';
                    scheduledCallsList.innerHTML = html;
                    
                } catch (error) {
                    console.error('Error loading calls:', error);
                    scheduledCallsList.innerHTML = '<p style="color:red;">Error loading calls</p>';
                }
            });
        }
    }
});