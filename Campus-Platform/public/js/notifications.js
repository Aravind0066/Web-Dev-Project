/**
 * Browser Notifications Utility
 * Handles OS-level notifications for the campus platform
 */

class NotificationManager {
  constructor() {
    this.permission = null;
    this.checkPermission();
  }

  async checkPermission() {
    if (!("Notification" in window)) {
      console.warn("This browser does not support notifications");
      return false;
    }

    this.permission = Notification.permission;
    
    if (this.permission === "default") {
      // Request permission
      try {
        this.permission = await Notification.requestPermission();
      } catch (err) {
        console.error("Error requesting notification permission:", err);
      }
    }

    return this.permission === "granted";
  }

  async show(title, options = {}) {
    if (!("Notification" in window)) {
      return false;
    }

    if (this.permission !== "granted") {
      const granted = await this.checkPermission();
      if (!granted) {
        return false;
      }
    }

    const defaultOptions = {
      icon: "/favicon.ico", // You can add a favicon later
      badge: "/favicon.ico",
      tag: "campus-platform",
      requireInteraction: false,
      ...options
    };

    try {
      const notification = new Notification(title, defaultOptions);
      
      notification.onclick = () => {
        window.focus();
        notification.close();
      };

      // Auto-close after 5 seconds
      setTimeout(() => {
        notification.close();
      }, 5000);

      return true;
    } catch (err) {
      console.error("Error showing notification:", err);
      return false;
    }
  }

  showNotice(title, body, priority = "normal") {
    const icons = {
      normal: "📢",
      important: "⚠️",
      emergency: "🚨"
    };

    return this.show(`${icons[priority] || "📢"} ${title}`, {
      body: body,
      tag: `notice-${priority}`,
      requireInteraction: priority === "emergency"
    });
  }

  showNewPost(type, author, title) {
    const icons = {
      update: "📝",
      query: "❓"
    };

    return this.show(`${icons[type] || "📝"} New ${type === "update" ? "Update" : "Query"}`, {
      body: `${author}: ${title}`,
      tag: `post-${type}`
    });
  }
}

// Global instance
const notificationManager = new NotificationManager();

// Listen for new notices (polling or WebSocket in future)
let lastNoticeCheck = null;

async function checkNewNotices() {
  try {
    const res = await fetch("/api/notices", { credentials: "include" });
    const json = await res.json();
    
    if (json.success && json.data && json.data.length > 0) {
      const latestNotice = json.data[0];
      const noticeTime = new Date(latestNotice.created_at).getTime();
      
      if (!lastNoticeCheck || noticeTime > lastNoticeCheck) {
        if (lastNoticeCheck) {
          // Only notify if it's a new notice (not on first load)
          notificationManager.showNotice(
            latestNotice.title,
            latestNotice.body.substring(0, 100),
            latestNotice.priority
          );
        }
        lastNoticeCheck = noticeTime;
      }
    }
  } catch (err) {
    console.error("Error checking notices:", err);
  }
}

// Check for new notices every 30 seconds
if (typeof window !== "undefined") {
  // Initial check after 5 seconds (to avoid notification on page load)
  setTimeout(() => {
    checkNewNotices();
    // Then check every 30 seconds
    setInterval(checkNewNotices, 30000);
  }, 5000);
}
