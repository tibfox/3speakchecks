#!/bin/bash
# CheckBanned API Setup Script for Production

echo "Setting up CheckBanned API as systemd service..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (sudo)"
  exit 1
fi

# Copy service file to systemd directory
cp checkbanned-api.service /etc/systemd/system/

# Reload systemd daemon
systemctl daemon-reload

# Enable the service to start on boot
systemctl enable checkbanned-api.service

# Start the service
systemctl start checkbanned-api.service

# Check status
systemctl status checkbanned-api.service

echo ""
echo "Setup complete! The CheckBanned API is now running as a system service."
echo ""
echo "Useful commands:"
echo "  sudo systemctl start checkbanned-api     # Start the service"
echo "  sudo systemctl stop checkbanned-api      # Stop the service"
echo "  sudo systemctl restart checkbanned-api   # Restart the service"
echo "  sudo systemctl status checkbanned-api    # Check service status"
echo "  sudo journalctl -u checkbanned-api -f    # View live logs"
echo "  sudo systemctl disable checkbanned-api   # Disable auto-start on boot"
echo ""