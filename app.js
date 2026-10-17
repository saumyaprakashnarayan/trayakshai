/**
 * TrayakshAI Single Page Application Router & Interactions
 */

(function () {
  'use strict';

  // Service route title mapping
  const SERVICE_TITLES = {
    'hpc': 'HPC Solutions — TrayakshAI | High Performance Computing',
    'quantum-computing': 'Quantum Computing — TrayakshAI | Hybrid Quantum Solutions',
    'data-storage-and-management': 'Data Storage & Management — TrayakshAI | Enterprise High-Throughput Fabric',
    'extreme-hft-servers': 'eXtreme HFT Servers — TrayakshAI | Overclocked Low Latency Trading Systems',
    'bespoke-servers': 'Bespoke Servers & Workstations — TrayakshAI | Custom Engineered Systems',
    'cloud-hpc': 'TrayakshAI Cloud — TrayakshAI | On-Demand Supercomputing & Hybrid Cloud',
    'data-ai-solutions': 'Data and AI Solutions — TrayakshAI | Full-Lifecycle Enterprise MLOps',
    'networking': 'High-Speed Networking — TrayakshAI | InfiniBand & Spectrum-X Fabrics',
    'ai-data-scientists': 'AI for Data Scientists — TrayakshAI | Deskside GPU Supercomputers',
    'scaling-ai': 'Scaling AI Infrastructure — TrayakshAI | NVIDIA SuperPOD & Multi-Node Clusters',
    'xpu': 'Heterogeneous xPU (CPU, GPU, DPU, IPU) — TrayakshAI | Next-Gen Silicon',
    'storage-solutions': 'Storage Solutions — TrayakshAI | 10TB to 40+ PB Parallel Storage'
  };

  const DEFAULT_TITLE = 'TrayakshAI — Develop & Deploy AI Solutions';

  /**
   * Switch the active view
   */
  function switchView(viewId, anchorId = null) {
    const views = document.querySelectorAll('.spa-view');
    let targetView = document.getElementById(`view-${viewId}`);
    if (!targetView) {
      targetView = document.getElementById('view-home');
      viewId = 'home';
    }

    // Toggle active view classes
    views.forEach(v => {
      if (v === targetView) {
        v.classList.add('active');
        v.style.display = 'block';
      } else {
        v.classList.remove('active');
        v.style.display = 'none';
      }
    });

    // Update Document Title
    if (viewId === 'home') {
      document.title = DEFAULT_TITLE;
    } else if (SERVICE_TITLES[viewId]) {
      document.title = SERVICE_TITLES[viewId];
    }

    // Update Nav Active state
    const navLinks = document.querySelectorAll('.links a, .nav-links a');
    navLinks.forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;
      if (viewId === 'home') {
        if (anchorId && href.includes(anchorId)) {
          link.style.color = 'var(--tx)';
        } else {
          link.style.color = '';
        }
      } else {
        if (href.includes('services')) {
          link.style.color = 'var(--tx)';
        } else {
          link.style.color = '';
        }
      }
    });

    // Scroll handling
    if (anchorId) {
      setTimeout(() => {
        const el = document.getElementById(anchorId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, 50);
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  /**
   * Parse the hash and route
   */
  function handleRoute() {
    let hash = window.location.hash.trim();
    if (!hash || hash === '#' || hash === '#/' || hash === '#top') {
      switchView('home');
      return;
    }

    // Service route: #/services/hpc or #services/hpc or #/hpc
    const serviceMatch = hash.match(/^#\/?services\/([a-zA-Z0-9_-]+)/) || hash.match(/^#\/?([a-zA-Z0-9_-]+)$/);
    if (serviceMatch) {
      const slug = serviceMatch[1];
      // Check if this slug matches a known service
      if (SERVICE_TITLES[slug]) {
        switchView(slug);
        return;
      }
      // Or check if this slug is an in-page section anchor on home (e.g. #services, #process, #industries, #leadership, #partners, #contact)
      const homeSections = ['services', 'process', 'industries', 'leadership', 'founders', 'partners', 'contact', 'top'];
      if (homeSections.includes(slug)) {
        const targetAnchor = slug === 'founders' ? 'leadership' : slug;
        switchView('home', targetAnchor);
        return;
      }
    }

    // Default fallback to home
    switchView('home');
  }

  // Set up event listeners on DOM Ready
  window.addEventListener('DOMContentLoaded', () => {
    // Initial Route
    handleRoute();
    window.addEventListener('hashchange', handleRoute);

    // Global Click Delegation
    document.addEventListener('click', (e) => {
      // Accordion Trigger Handler
      const trigger = e.target.closest('.acc-trigger');
      if (trigger) {
        e.preventDefault();
        const item = trigger.closest('.acc-item');
        if (!item) return;
        const parentList = item.closest('.accordion-list');
        const isCurrentlyActive = item.classList.contains('active');

        if (parentList) {
          parentList.querySelectorAll('.acc-item').forEach(i => i.classList.remove('active'));
        }
        if (!isCurrentlyActive) {
          item.classList.add('active');
        }
        return;
      }

      // Service Card Clicks (on Home View)
      const serviceCard = e.target.closest('.card[data-service]');
      if (serviceCard) {
        e.preventDefault();
        const serviceId = serviceCard.getAttribute('data-service');
        if (serviceId) {
          window.location.hash = `#/services/${serviceId}`;
        }
        return;
      }

      // Back to All Services Link
      const backLink = e.target.closest('.back-link');
      if (backLink) {
        e.preventDefault();
        window.location.hash = '#services';
        return;
      }

      // Navigation Link Clicks (when inside a service page, clicking nav links switches back to home)
      const navLink = e.target.closest('.links a, .brand');
      if (navLink) {
        const href = navLink.getAttribute('href');
        if (href && href.startsWith('#')) {
          const targetSection = href.replace('#', '');
          const activeView = document.querySelector('.spa-view.active');
          if (activeView && activeView.id !== 'view-home') {
            e.preventDefault();
            window.location.hash = '#' + targetSection;
          }
        }
      }
    });

    // Keyboard accessibility for Service Cards (Enter / Space)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const activeCard = document.activeElement;
        if (activeCard && activeCard.classList.contains('card') && activeCard.getAttribute('data-service')) {
          e.preventDefault();
          const serviceId = activeCard.getAttribute('data-service');
          window.location.hash = `#/services/${serviceId}`;
        }
      }
    });
  });

})();
