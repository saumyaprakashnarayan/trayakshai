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

      // Check if this slug matches a known service view
      if (SERVICE_TITLES[slug]) {
        switchView(slug);
        return;
      }

      // Check if this slug is an in-page section anchor on home
      const homeSections = ['services', 'academy', 'process', 'industries', 'leadership', 'founders', 'partners', 'contact', 'top'];
      if (homeSections.includes(slug)) {
        const targetAnchor = slug === 'founders' ? 'leadership' : slug;
        switchView('home', targetAnchor);
        return;
      }

      // Check if the currently active view contains an element with this ID (intra-view navigation)
      const activeView = document.querySelector('.spa-view.active');
      if (activeView && activeView.id !== 'view-home') {
        const elInView = activeView.querySelector(`#${slug}`) || 
                         activeView.querySelector(`[id*="${slug}"]`) ||
                         (slug === 'contact' ? activeView.querySelector('.cta-band-section') : null);
        if (elInView) {
          setTimeout(() => {
            elInView.scrollIntoView({ behavior: 'smooth' });
          }, 40);
          return;
        }
      }

      // Check if an element with this ID exists elsewhere in the DOM (e.g. service-specific anchor)
      const anyTarget = document.getElementById(slug);
      if (anyTarget) {
        const parentView = anyTarget.closest('.spa-view');
        if (parentView) {
          const viewRoute = parentView.getAttribute('data-route') || parentView.id.replace('view-', '');
          switchView(viewRoute, slug);
          return;
        }
      }
    }

    // Default fallback to home
    switchView('home');
  }

  // Consultation Modal Controls
  function openConsultationModal(serviceName = 'AI Infrastructure', serviceSlug = '') {
    const modal = document.getElementById('consultation-modal');
    if (!modal) return;
    const nameEl = document.getElementById('modal-service-name');
    const mailtoLink = document.getElementById('consult-mailto-link');
    if (nameEl) nameEl.textContent = serviceName;
    if (mailtoLink) {
      const subject = encodeURIComponent(`TrayakshAI Consultation Request: ${serviceName}`);
      mailtoLink.href = `mailto:hello@trayakshai.com?subject=${subject}`;
    }
    const form = document.getElementById('consultation-form');
    const success = document.getElementById('consultation-success');
    if (form) form.style.display = 'block';
    if (success) success.style.display = 'none';
    modal.style.display = 'flex';
  }

  function closeConsultationModal() {
    const modal = document.getElementById('consultation-modal');
    if (modal) modal.style.display = 'none';
  }

  window.handleConsultationSubmit = function (e) {
    e.preventDefault();
    const name = (document.getElementById('consult-name') || {}).value || '';
    const email = (document.getElementById('consult-email') || {}).value || '';
    const notes = (document.getElementById('consult-notes') || {}).value || '';
    const serviceName = (document.getElementById('modal-service-name') || {}).textContent || 'AI Infrastructure';

    // Construct direct mailto fallback link for client convenience
    const subject = encodeURIComponent(`TrayakshAI Discovery Call: ${serviceName}`);
    const body = encodeURIComponent(`Name: ${name}\nEmail: ${email}\nArchitecture Interest: ${serviceName}\nScope / Details:\n${notes}\n`);
    
    const form = document.getElementById('consultation-form');
    const success = document.getElementById('consultation-success');
    if (form) form.style.display = 'none';
    if (success) success.style.display = 'block';

    setTimeout(() => {
      window.location.href = `mailto:hello@trayakshai.com?subject=${subject}&body=${body}`;
    }, 1200);
  };

  // Set up event listeners on DOM Ready
  window.addEventListener('DOMContentLoaded', () => {
    // Initial Route
    handleRoute();
    window.addEventListener('hashchange', handleRoute);

    // Modal close listeners
    const closeBtn = document.getElementById('close-consultation-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeConsultationModal);

    const consultModal = document.getElementById('consultation-modal');
    if (consultModal) {
      consultModal.addEventListener('click', (e) => {
        if (e.target === consultModal) closeConsultationModal();
      });
    }

    // Global Click Delegation
    document.addEventListener('click', (e) => {
      // Consultation Modal Trigger
      const modalTrigger = e.target.closest('[data-open-modal]');
      if (modalTrigger) {
        e.preventDefault();
        const serviceSlug = modalTrigger.getAttribute('data-service') || '';
        const serviceName = SERVICE_TITLES[serviceSlug] ? SERVICE_TITLES[serviceSlug].split('—')[0].trim() : 'AI Infrastructure';
        openConsultationModal(serviceName, serviceSlug);
        return;
      }

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
      if (e.key === 'Escape') {
        closeConsultationModal();
      }
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
