(function () {
  'use strict';

  // ========================================
  // State
  // ========================================

  let addresses = [];
  let selectedAddress = null;
  let lastQuery = '';
  let lastResults = [];
  let debounceTimer = null;
  let map = null;
  let mapMarker = null;
  let userLat = null;
  let userLon = null;

  // ========================================
  // DOM refs
  // ========================================

  const screenSearch = document.getElementById('screen-search');
  const screenConfirm = document.getElementById('screen-confirm');
  const searchInput = document.getElementById('search-input');
  const btnClear = document.getElementById('btn-clear');
  const btnBack = document.getElementById('btn-back');
  const btnLocation = document.getElementById('btn-location');
  const resultsList = document.getElementById('results-list');
  const confirmLine1 = document.getElementById('confirm-line1');
  const confirmLine2 = document.getElementById('confirm-line2');
  const unitInput = document.getElementById('unit-input');
  const btnConfirm = document.getElementById('btn-confirm');
  const btnChange = document.getElementById('btn-change');
  const btnConfirmBack = document.getElementById('btn-confirm-back');
  const confirmMapEl = document.getElementById('confirm-map');
  const addressDisplay = document.getElementById('address-display');
  const addressEditForm = document.getElementById('address-edit-form');
  const btnEditAddress = document.getElementById('btn-edit-address');
  const btnSaveEdit = document.getElementById('btn-save-edit');
  const editLine1 = document.getElementById('edit-line1');
  const editCity = document.getElementById('edit-city');
  const editState = document.getElementById('edit-state');
  const editZip = document.getElementById('edit-zip');

  // ========================================
  // Address helpers
  // ========================================

  function getStreetLine(addr) {
    const num = addr.address.house_number || '';
    const road = addr.address.road || '';
    return (num + ' ' + road).trim();
  }

  function getCityLine(addr) {
    const city = addr.address.city || addr.address.town || addr.address.village || '';
    const state = addr.address.state || '';
    const zip = addr.address.postcode || '';
    return city + ' ' + state + ', ' + zip;
  }

  function toFlexShape(addr, unit) {
    return {
      addressLine1: getStreetLine(addr),
      addressLine2: unit || '',
      city: addr.address.city || addr.address.town || '',
      state: addr.address.state || '',
      zip: addr.address.postcode || '',
    };
  }

  // ========================================
  // Local address search (10K static dataset, sorted by proximity)
  // ========================================

  // Squared distance (no need for sqrt/haversine — just ranking)
  function distSq(lat1, lon1, lat2, lon2) {
    var dLat = lat2 - lat1;
    var dLon = (lon2 - lon1) * Math.cos(lat1 * 0.01745);
    return dLat * dLat + dLon * dLon;
  }

  function searchAddresses(query) {
    if (!query || query.length < 2) return [];

    var q = query.toLowerCase();

    var matched = addresses.filter(function (addr) {
      // Prefix match: query must appear at the START of house number, full street, city, or zip
      var fullStreet = (addr.address.house_number + ' ' + addr.address.road).toLowerCase();
      var road = (addr.address.road || '').toLowerCase();
      var city = (addr.address.city || '').toLowerCase();
      var zip = addr.address.postcode || '';
      return fullStreet.indexOf(q) === 0 || road.indexOf(q) === 0 || city.indexOf(q) === 0 || zip.indexOf(q) === 0;
    });

    // Sort by distance to user if location is available
    if (userLat !== null && userLon !== null) {
      matched.sort(function (a, b) {
        return distSq(userLat, userLon, parseFloat(a.lat), parseFloat(a.lon))
             - distSq(userLat, userLon, parseFloat(b.lat), parseFloat(b.lon));
      });
    }

    var results = matched.slice(0, 5);
    lastResults = results;
    return results;
  }

  function renderResults(results) {
    resultsList.innerHTML = '';

    if (searchInput.value.length >= 2 && results.length === 0) {
      resultsList.innerHTML = '<div class="no-results">No addresses found. Try adding a street name.</div>';
      return;
    }

    results.forEach(function (addr) {
      var row = document.createElement('div');
      row.className = 'result-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');

      row.innerHTML =
        '<div class="result-text">' +
          '<div class="result-line1">' + escapeHtml(getStreetLine(addr)) + '</div>' +
          '<div class="result-line2">' + escapeHtml(getCityLine(addr)) + '</div>' +
        '</div>' +
        '<svg class="result-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none">' +
          '<path d="M7.5 4L13.5 10L7.5 16" stroke="#C4C4C4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';

      row.addEventListener('click', function () {
        selectAddress(addr);
      });

      resultsList.appendChild(row);
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ========================================
  // Screen transitions
  // ========================================

  function showScreen(screen) {
    screenSearch.classList.remove('active');
    screenConfirm.classList.remove('active');
    screen.classList.add('active');
  }

  function selectAddress(addr) {
    selectedAddress = addr;
    lastQuery = searchInput.value;

    confirmLine1.textContent = getStreetLine(addr);
    confirmLine2.textContent = getCityLine(addr);
    unitInput.value = '';

    // Reset to display mode (in case edit was open)
    addressEditForm.style.display = 'none';
    addressDisplay.style.display = 'flex';

    showScreen(screenConfirm);
    initMap(parseFloat(addr.lat), parseFloat(addr.lon));
  }

  function goBackToSearch() {
    showScreen(screenSearch);
    searchInput.value = lastQuery;
    searchInput.focus();
    updateClearButton();

    // Re-render cached results from the last search (no extra API call)
    renderResults(lastResults);

    // Destroy map to free memory
    if (map) {
      map.remove();
      map = null;
      mapMarker = null;
    }
  }

  // ========================================
  // Map (Leaflet + dark tiles)
  // ========================================

  function initMap(lat, lon) {
    // Clean up previous instance
    if (map) {
      map.remove();
      map = null;
      mapMarker = null;
    }

    map = L.map(confirmMapEl, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
    }).setView([lat, lon], 16);

    // Light tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // Custom pin marker
    var pinIcon = L.divIcon({
      className: 'map-pin',
      html: '<div class="map-pin-inner"></div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    mapMarker = L.marker([lat, lon], { icon: pinIcon }).addTo(map);

    // Force size recalculation after screen transition
    setTimeout(function () {
      map.invalidateSize();
    }, 50);
  }

  // ========================================
  // Clear button visibility
  // ========================================

  function updateClearButton() {
    if (searchInput.value.length > 0) {
      btnClear.classList.add('visible');
    } else {
      btnClear.classList.remove('visible');
    }
  }

  // ========================================
  // Event listeners
  // ========================================

  // Search input with short debounce (local filtering is instant)
  searchInput.addEventListener('input', function () {
    updateClearButton();

    clearTimeout(debounceTimer);

    if (searchInput.value.length < 2) {
      resultsList.innerHTML = '';
      return;
    }

    debounceTimer = setTimeout(function () {
      var results = searchAddresses(searchInput.value);
      renderResults(results);
    }, 50);
  });

  // Clear button
  btnClear.addEventListener('click', function () {
    searchInput.value = '';
    resultsList.innerHTML = '';
    updateClearButton();
    searchInput.focus();
  });

  // Back button (on search screen — currently no-op, could go to previous onboarding step)
  btnBack.addEventListener('click', function () {
    searchInput.value = '';
    resultsList.innerHTML = '';
    updateClearButton();
  });

  // Location link — reverse geocode via Nominatim
  btnLocation.addEventListener('click', function (e) {
    e.preventDefault();
    if (!('geolocation' in navigator)) return;

    btnLocation.textContent = 'Getting location...';

    navigator.geolocation.getCurrentPosition(
      async function (pos) {
        var lat = pos.coords.latitude;
        var lon = pos.coords.longitude;
        userLat = lat;
        userLon = lon;
        console.log('[Prototype] Geolocation granted:', lat, lon);

        try {
          var params = new URLSearchParams({
            lat: lat,
            lon: lon,
            format: 'jsonv2',
            addressdetails: '1',
            zoom: '18',
          });
          var resp = await fetch(
            'https://nominatim.openstreetmap.org/reverse?' + params.toString(),
            { headers: { 'Accept': 'application/json' } }
          );
          var result = await resp.json();

          if (result && result.address) {
            selectAddress(result);
          }
        } catch (err) {
          console.error('[Prototype] Reverse geocode failed:', err);
        }

        btnLocation.textContent = 'Use current location instead';
      },
      function () {
        console.log('[Prototype] Geolocation denied');
        btnLocation.textContent = 'Use current location instead';
      }
    );
  });

  // Confirm button
  btnConfirm.addEventListener('click', function () {
    if (!selectedAddress) return;

    var flexAddress = toFlexShape(selectedAddress, unitInput.value);
    console.log('[Prototype] Address confirmed (Flex shape):', flexAddress);
    console.log('[Prototype] Raw Nominatim data:', selectedAddress);

    // Visual feedback
    btnConfirm.textContent = 'Confirmed!';
    btnConfirm.style.background = '#2D7A3A';
    setTimeout(function () {
      btnConfirm.textContent = 'Confirm';
      btnConfirm.style.background = '';
    }, 1500);
  });

  // Change address
  btnChange.addEventListener('click', function () {
    goBackToSearch();
  });

  // Confirm screen back button
  btnConfirmBack.addEventListener('click', function () {
    goBackToSearch();
  });

  // Edit address inline
  btnEditAddress.addEventListener('click', function () {
    // Populate edit fields from current address
    editLine1.value = getStreetLine(selectedAddress);
    editCity.value = selectedAddress.address.city || selectedAddress.address.town || '';
    editState.value = selectedAddress.address.state || '';
    editZip.value = selectedAddress.address.postcode || '';

    addressDisplay.style.display = 'none';
    addressEditForm.style.display = 'flex';
    editLine1.focus();
  });

  // Save edited address
  btnSaveEdit.addEventListener('click', function () {
    // Update the selected address with edited values
    var parts = editLine1.value.trim().split(' ');
    selectedAddress.address.house_number = parts[0] || '';
    selectedAddress.address.road = parts.slice(1).join(' ') || '';
    selectedAddress.address.city = editCity.value.trim();
    selectedAddress.address.state = editState.value.trim();
    selectedAddress.address.postcode = editZip.value.trim();

    // Update display
    confirmLine1.textContent = getStreetLine(selectedAddress);
    confirmLine2.textContent = getCityLine(selectedAddress);

    // Switch back to display mode
    addressEditForm.style.display = 'none';
    addressDisplay.style.display = 'flex';

    console.log('[Prototype] Address manually edited:', toFlexShape(selectedAddress, unitInput.value));
  });

  // ========================================
  // Init — load address dataset then enable search
  // ========================================

  // Request user location in background for proximity sorting
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        userLat = pos.coords.latitude;
        userLon = pos.coords.longitude;
        console.log('[Prototype] User location acquired:', userLat, userLon);
      },
      function () {
        console.log('[Prototype] Geolocation denied — results will not be sorted by proximity');
      }
    );
  }

  searchInput.disabled = true;
  searchInput.placeholder = 'Loading addresses...';

  fetch('data/sample-addresses.json')
    .then(function (resp) { return resp.json(); })
    .then(function (data) {
      addresses = data;
      searchInput.disabled = false;
      searchInput.placeholder = 'Search address';
      searchInput.focus();
      console.log('[Prototype] Loaded ' + addresses.length + ' addresses');
    })
    .catch(function (err) {
      console.error('[Prototype] Failed to load addresses:', err);
      searchInput.placeholder = 'Error loading addresses';
    });
})();
