// Show admin link in navbar for admin users
(function() {
  const userRole = localStorage.getItem("userRole");
  const adminLink = document.getElementById("adminLink");
  if (adminLink && userRole === "admin") {
    adminLink.style.display = "inline";
  }
})();
