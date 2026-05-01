const { HapClient } = require('@homebridge/hap-client');
const debug = require('debug')('hapNodeRed:hbConfigNode');
const fs = require('fs');
const path = require('path');
const process = require('process');

class HBConfigNode {
  constructor(config, RED) {
    RED.nodes.createNode(this, config);

    // Initialize properties
    this.username = config.username;
    this.macAddress = config.macAddress || '';
    this.debugLogging = config.debug || false;
    this.users = {};
    this.homebridge = null;
    this.evDevices = [];
    this.ctDevices = [];
    this.hbDevices = [];
    this.clientNodes = [];

    // Initialize HAP client
    this.hapClient = new HapClient({
      config: { debug: false },
      pin: config.username
    });

    this.hapClient.on('instance-discovered', this.waitForNoMoreDiscoveries);
    this.hapClient.on('discovery-ended', this.hapClient.refreshInstances);
    if (this.on)
      this.on('close', this.close.bind(this));
  }

  waitForNoMoreDiscoveries = (instance) => {
    if (instance)
      debug('Instance discovered: %s - %s %s:%s', instance?.name, instance?.username, instance?.ipAddress, instance?.port);
    // Serialize handleReady() calls so concurrent instance-discovered events
    // don't race in connectClientNodes/monitorDevices. The skip condition
    // makes redundant follow-up runs cheap.
    this._readyChain = (this._readyChain || Promise.resolve())
      .catch(() => {})
      .then(() => this.handleReady())
      .catch(e => this.error(`handleReady error: ${e.stack || e}`));
  };

  /**
   * Fetch all services, update hbDevices, and connect registered nodes.
   * Skips reconnect if nothing changed and all nodes are already connected.
   */
  async handleReady() {
    const updatedDevices = await this.hapClient.getAllServices();
    if (!updatedDevices || updatedDevices.length === 0) {
      debug('No devices returned yet, waiting for instance-discovered to retry');
      return;
    }
    if (this.debugLogging && updatedDevices && updatedDevices.length && process.uptime() < 300) {
      try {
        const storagePath = path.join(process.cwd(), 'homebridge-automation-endpoints.json');
        this.warn(`Writing Homebridge endpoints to ${storagePath}`);
        fs.writeFileSync(storagePath, JSON.stringify(updatedDevices, null, 2));
      } catch (e) {
        this.error(`Error writing Homebridge endpoints to file: ${e.message}`);
      }
    }
    // Fix broken uniqueId's from HAP-Client
    updatedDevices.forEach((service) => {
      const friendlyName = (service.accessoryInformation.Name ? service.accessoryInformation.Name : service.serviceName);
      service.uniqueId = `${service.instance.name}${service.instance.username}${service.accessoryInformation.Manufacturer}${friendlyName}${service.uuid.slice(0, 8)}`;
    });
    let changed = false;
    updatedDevices.forEach((updatedService, index) => {
      if (this.hbDevices.find(service => service.uniqueId === updatedService.uniqueId)) {
        // debug(`Exsiting UniqueID breakdown - ${updatedService.serviceName}-${updatedService.instance.username}-${updatedService.aid}-${updatedService.iid}-${updatedService.type}`);
        const update = this.hbDevices.find(service => service.uniqueId === updatedService.uniqueId);
        update.instance = updatedService.instance;
      } else {
        // debug(`New Service UniqueID breakdown - ${updatedService.serviceName}-${updatedService.instance.username}-${updatedService.aid}-${updatedService.iid}-${updatedService.type}`);
        this.hbDevices.push(updatedService);
        changed = true;
      }
    });
    const hasUnconnectedNodes = Object.values(this.clientNodes).some(n => !n.hbDevice);
    if (!changed && this.monitor && !hasUnconnectedNodes) {
      debug('handleReady: monitor active, no new devices, all nodes matched - skipping reconnect');
      return;
    }
    this.evDevices = this.toList({ perms: 'ev' });
    this.ctDevices = this.toList({ perms: 'pw' });
    this.log(`Devices initialized: evDevices: ${this.evDevices.length}, ctDevices: ${this.ctDevices.length}`);
    this.handleDuplicates(this.evDevices);
    await this.connectClientNodes();
  }

  toList(perms) {
    const supportedTypes = new Set([
      'Air Purifier', 'Air Quality Sensor', 'Battery', 'Carbon Dioxide Sensor', 'Carbon Monoxide Sensor', 'Camera Rtp Stream Management',
      'Doorbell', 'Fan', 'Fanv2', 'Garage Door Opener', 'Humidity Sensor', 'Input Source',
      'Leak Sensor', 'Light Sensor', 'Lightbulb', 'Lock Mechanism', 'Motion Sensor', 'Occupancy Sensor',
      'Outlet', 'Smoke Sensor', 'Speaker', 'Stateless Programmable Switch', 'Switch',
      'Television', 'Temperature Sensor', 'Thermostat', 'Contact Sensor',
      'Window', 'Window Covering', 'Light Sensor'
    ]);
    return filterUnique(this.hbDevices)
      .filter(service => supportedTypes.has(service.humanType))
      .map(service => ({
        name: (service.accessoryInformation.Name ? service.accessoryInformation.Name : service.serviceName),
        fullName: `${(service.accessoryInformation.Name ? service.accessoryInformation.Name : service.serviceName)} - ${service.humanType}`,
        sortName: `${(service.accessoryInformation.Name ? service.accessoryInformation.Name : service.serviceName)}:${service.type}`,
        uniqueId: service.uniqueId,
        homebridge: service.instance.name,
        service: service.type,
        manufacturer: service.accessoryInformation.Manufacturer,
      }))
      .sort((a, b) => a.sortName.localeCompare(b.sortName));
  }


  handleDuplicates(list) {
    const seen = new Map();

    list.forEach(endpoint => {
      const { fullName, uniqueId } = endpoint;

      if (seen.has(fullName)) {
        this.warn(`Duplicate device name detected: ${fullName}`);
      }
      if (seen.has(uniqueId)) {
        this.error(`Duplicate uniqueId detected: ${uniqueId}`);
      }

      seen.set(fullName, true);
      seen.set(uniqueId, true);
    });
  }

  registerClientNode(clientNode) {
    debug('Register: %s type: %s', clientNode.type, clientNode.name);
    this.clientNodes[clientNode.id] = clientNode;
    clientNode.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
    this.waitForNoMoreDiscoveries(); // Connect new nodes created after startup has ended ( Need a function to rather than brute forcing it )
  }

  async connectClientNodes() {
    debug('connect %s nodes', Object.keys(this.clientNodes).length);
    for (const [key, clientNode] of Object.entries(this.clientNodes)) {
      const matchedDevice = this.hbDevices.find(service => {
        const friendlyName = (service.accessoryInformation.Name ? service.accessoryInformation.Name : service.serviceName);
        const deviceIdentifier = `${service.instance.name}${service.instance.username}${service.accessoryInformation.Manufacturer}${friendlyName}${service.uuid.slice(0, 8)}`;
        return clientNode.device === deviceIdentifier;
      });

      if (matchedDevice) {
        clientNode.hbDevice = matchedDevice;
        clientNode.status({ fill: 'green', shape: 'dot', text: 'connected' });
        clientNode.emit('hbReady', matchedDevice);
        debug('_Registered: %s type: %s', clientNode.type, matchedDevice.type, matchedDevice.serviceName);
      } else {
        this.error(`ERROR: Device registration failed '${clientNode.fullName}' - '${clientNode.device}'`);
      }
    };

    await this.monitorDevices();
  }

  async monitorDevices() {
    if (Object.keys(this.clientNodes).length) {

      const monitorNodes = Object.values(this.clientNodes)
        .filter(node => ['hb-status', 'hb-event', 'hb-resume'].includes(node.type)) // Filter by type
        .map(node => node.hbDevice) // Map to hbDevice property
        .filter(Boolean); // Remove any undefined or null values, if present;
      this.log(`Connected to ${Object.keys(monitorNodes).length} Homebridge devices`);
      if (this.monitor) {
        // Remove all listeners before finishing so stale events (e.g. monitor-close)
        // on the old monitor object don't trigger reconnect loops.
        try {
          this.monitor.removeAllListeners();
          this.monitor.finish();
        } catch (e) {
          debug('monitor cleanup error (already closed): %s', e.message);
        }
      }
      this.monitor = await this.hapClient.monitorCharacteristics(monitorNodes);
      this.monitor.on('service-update', (services) => {
        services.forEach(service => {
          const eventNodes = Object.values(this.clientNodes).filter(clientNode => {
            const deviceIdentifier = `${service.instance.name}${service.instance.username}${service.accessoryInformation.Manufacturer}${(service.accessoryInformation.Name ? service.accessoryInformation.Name : service.serviceName)}${service.uuid.slice(0, 8)}`;
            // debug('service-update: compare', clientNode.config.device, deviceIdentifier);
            return clientNode.config.device === deviceIdentifier;
          }
          );
          eventNodes.forEach(eventNode => eventNode.emit('hbEvent', service));
        });
      });
      this.monitor.on('monitor-close', (instance, hadError) => {
        debug('monitor-close', instance.name, instance.ipAddress, instance.port, hadError)
        this.disconnectClientNodes(instance);
        this.scheduleReconnect();
      })
      this.monitor.on('monitor-refresh', (instance, hadError) => {
        debug('monitor-refresh', instance.name, instance.ipAddress, instance.port, hadError)
        // Instance self-recovered; cancel any pending reconnect attempt
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
        this.reconnectClientNodes(instance);
      })
      this.monitor.on('monitor-error', (instance, hadError) => {
        debug('monitor-error', instance, hadError)
      })
    }
  }

  disconnectClientNodes(instance) {
    debug('disconnectClientNodes', `${instance.ipAddress}:${instance.port}`);
    this.monitor = null; // force next handleReady() to rebuild the monitor
    const clientNodes = Object.values(this.clientNodes).filter(clientNode => {
      return `${clientNode.hbDevice?.instance.ipAddress}:${clientNode.hbDevice?.instance.port}` === `${instance.ipAddress}:${instance.port}`;
    });

    clientNodes.forEach(clientNode => {
      clientNode.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      clientNode.emit('hbDisconnected', instance);
    });
  }

  reconnectClientNodes(instance) {
    debug('reconnectClientNodes', `${instance.ipAddress}:${instance.port}`);
    const clientNodes = Object.values(this.clientNodes).filter(clientNode => {
      return `${clientNode.hbDevice?.instance.ipAddress}:${clientNode.hbDevice?.instance.port}` === `${instance.ipAddress}:${instance.port}`;
    });

    clientNodes.forEach(clientNode => {
      clientNode.status({ fill: 'green', shape: 'dot', text: 'connected' });
      clientNode.emit('hbReady', clientNode.hbDevice);
    });
  }

  /**
   * Reconnect after monitor-close: calls handleReady() after 5s so instance
   * info is refreshed. Retries every 5s; cancelled on monitor-refresh or close.
   */
  scheduleReconnect() {
    if (this.reconnectTimeout) return; // already scheduled
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      debug('Auto-reconnect: re-fetching services after monitor-close');
      // Use the same chain as waitForNoMoreDiscoveries so reconnects don't
      // race with concurrent registerClientNode/instance-discovered runs.
      this._readyChain = (this._readyChain || Promise.resolve())
        .catch(() => {})
        .then(() => this.handleReady())
        .catch(e => {
          this.error(`Auto-reconnect failed: ${e.stack || e}, retrying in 5s`);
          this.scheduleReconnect();
        });
    }, 5000);
  }

  close() {
    debug('hb-config: close');
    clearTimeout(this.reconnectTimeout);
    this.hapClient?.destroy();
  }
}


// Filter unique devices by AID, service name, username, and port
const filterUnique = (data) => {
  const seen = new Set();
  return data.filter(item => {
    const uniqueKey = `${item.aid}-${item.serviceName}-${item.humanType}-${item.instance.username}-${item.instance.port}`;
    if (seen.has(uniqueKey)) return false;
    seen.add(uniqueKey);
    return true;
  });
};

module.exports = HBConfigNode;
