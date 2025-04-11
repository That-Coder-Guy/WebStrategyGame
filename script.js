// Ensure strict mode and basic error handling
'use strict';

// --- Configuration ---
const MAP_SIZE = 64; // As requested (Warning: Performance intensive!)
const TILE_SIZE = 1;   // Size of each square tile in world units
const NOISE_SCALE = 100; // Controls the "zoom" level of the Perlin noise. Larger = larger features.
const CAMERA_FRUSTUM_SIZE = 100; // Determines the initial "zoom" level of the orthographic camera
const CAMERA_ANGLE_X = -Math.PI / 4; // Angle down towards the ground (approx 30 degrees)
const CAMERA_ANGLE_Y = Math.PI / 4;  // Angle sideways (approx 45 degrees) for isometric view
const DAY_NIGHT_SPEED = 0.0001; // Speed of the directional light rotation

// Tile type definitions (ordered by elevation)
const TILE_TYPES = {
    STONE: { color: 0x888888, minHeight: 0.80, baseElevation: 1.0 },
    GRASS_TREE: { color: 0x228B22, minHeight: 0.65, baseElevation: 0.5 }, // ForestGreen
    GRASS: { color: 0x32CD32, minHeight: 0.45, baseElevation: 0.4 },    // LimeGreen
    SAND: { color: 0xF4A460, minHeight: 0.35, baseElevation: 0.1 },     // SandyBrown
    WATER: { color: 0x1E90FF, minHeight: 0.0, baseElevation: -0.5 }      // DodgerBlue
};

// --- Global Variables ---
let scene, camera, renderer, noiseGenerator;
let directionalLight;
let mapGroup; // To hold all map tiles for easier management
let clock; // Added for FPS calculation
let fpsCounterElement; // Added for displaying FPS

// Mouse/Touch Dragging State
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };

// --- Initialization ---
function start() {
    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xaaaaaa); // Light grey background

    // Noise Generator
    noiseGenerator = new SimplexNoise();

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true; // Enable shadows
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Softer shadows

    // *** Get the container OR append directly to body ***
    const container = document.getElementById('game-container') || document.body;
    if (container === document.body) {
        // Ensure body takes full screen and has no margin if using body directly
        document.body.style.margin = "0";
        document.body.style.overflow = "hidden";
    }
    container.appendChild(renderer.domElement);

    // *** Add FPS Counter Element ***
    fpsCounterElement = document.createElement('div');
    fpsCounterElement.id = 'fps-counter';
    // Basic Styling (you might prefer doing this in a separate CSS file)
    fpsCounterElement.style.position = 'absolute';
    fpsCounterElement.style.top = '10px';
    fpsCounterElement.style.left = '10px';
    fpsCounterElement.style.borderRadius = '5px';
    fpsCounterElement.style.color = 'white';
    fpsCounterElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'; // Semi-transparent black
    fpsCounterElement.style.padding = '5px 10px';
    fpsCounterElement.style.fontFamily = 'sans-serif';
    fpsCounterElement.style.fontSize = '14px';
    fpsCounterElement.style.zIndex = '100'; // Ensure it's on top of the canvas
    fpsCounterElement.textContent = 'FPS: --'; // Initial text
    document.body.appendChild(fpsCounterElement); // Append to body to overlay everything

    // *** Initialize Clock ***
    clock = new THREE.Clock();

    // Camera setup (Orthographic)
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.OrthographicCamera(
        CAMERA_FRUSTUM_SIZE * aspect / -2,
        CAMERA_FRUSTUM_SIZE * aspect / 2,
        CAMERA_FRUSTUM_SIZE / 2,
        CAMERA_FRUSTUM_SIZE / -2,
        1,       // Near clipping plane
        2000     // Far clipping plane (needs to see the whole map diagonally)
    );

    // Position and angle the camera
    const cameraDistance = MAP_SIZE * TILE_SIZE * 0.7; // Start reasonably far out
    camera.position.set(
        cameraDistance * Math.sin(CAMERA_ANGLE_Y) * Math.cos(CAMERA_ANGLE_X),
        cameraDistance * Math.sin(CAMERA_ANGLE_X), // Negative Y is up in Three.js coord system if rotated this way? No, positive Y is up.
        cameraDistance * Math.cos(CAMERA_ANGLE_Y) * Math.cos(CAMERA_ANGLE_X)
    );
    // Adjust Y based on desired height
    camera.position.y = cameraDistance * 0.8; // Adjust this multiplier for height

    camera.rotation.order = 'YXZ'; // Set rotation order for intuitive angling
    camera.rotation.y = CAMERA_ANGLE_Y;
    camera.rotation.x = CAMERA_ANGLE_X;

    camera.lookAt(0, 0, 0); // Look at the center of the map initially
    scene.add(camera);

    // Lighting setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4); // Soft white ambient light
    scene.add(ambientLight);

    directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(MAP_SIZE / 4, MAP_SIZE / 2, MAP_SIZE / 4); // Initial position (e.g., morning sun)
    directionalLight.castShadow = true;
    directionalLight.target.position.set(0, 0, 0); // Target the center of the map

    // Shadow properties (adjust for performance vs quality)
    directionalLight.shadow.mapSize.width = 1024; // default 512
    directionalLight.shadow.mapSize.height = 1024; // default 512
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = MAP_SIZE * 1.5; // Needs to cover the map area
    // Adjust shadow camera frustum to cover the map
    const shadowCamSize = MAP_SIZE * TILE_SIZE / 1.5;
    directionalLight.shadow.camera.left = -shadowCamSize;
    directionalLight.shadow.camera.right = shadowCamSize;
    directionalLight.shadow.camera.top = shadowCamSize;
    directionalLight.shadow.camera.bottom = -shadowCamSize;

    scene.add(directionalLight);
    scene.add(directionalLight.target); // Add target to scene

    // --- Map Generation ---
    generateMap();

    // --- Event Listeners ---
    setupEventListeners();

    // Start the animation loop
    update();
}

// --- Map Generation ---
function generateMap() {
    console.log(`Generating ${MAP_SIZE}x${MAP_SIZE} map... (This may take a while)`);
    mapGroup = new THREE.Group();
    const tileGeometry = new THREE.BoxGeometry(TILE_SIZE, TILE_SIZE, TILE_SIZE);
    const materials = {}; // Cache materials

    // Pre-create materials
    for (const typeName in TILE_TYPES) {
        const type = TILE_TYPES[typeName];
        materials[typeName] = new THREE.MeshStandardMaterial({ color: type.color });
        if (typeName === 'WATER') {
             materials[typeName].transparent = true;
             materials[typeName].opacity = 0.8;
        }
    }
    // Tree materials (simple)
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // SaddleBrown
    const leavesMaterial = new THREE.MeshStandardMaterial({ color: 0x006400 }); // DarkGreen

    const halfMapSize = (MAP_SIZE * TILE_SIZE) / 2;
    const treeProbability = 0.4; // Chance of a tree spawning on a GRASS_TREE tile

    for (let x = 0; x < MAP_SIZE; x++) {
        for (let z = 0; z < MAP_SIZE; z++) {
            // Calculate world position
            const worldX = (x * TILE_SIZE) - halfMapSize + TILE_SIZE / 2;
            const worldZ = (z * TILE_SIZE) - halfMapSize + TILE_SIZE / 2;

            // Get Perlin noise value (normalized 0 to 1)
            const noiseValue = (noiseGenerator.noise2D(x / NOISE_SCALE, z / NOISE_SCALE) + 1) / 2;

            // Determine tile type based on noise height
            let currentTileType = TILE_TYPES.WATER; // Default to lowest
            let material = materials.WATER;
            let elevation = TILE_TYPES.WATER.baseElevation;

            // Find the correct tile type (iterate from highest to lowest)
            const typeKeys = Object.keys(TILE_TYPES).sort((a, b) => TILE_TYPES[b].minHeight - TILE_TYPES[a].minHeight);
            for (const typeName of typeKeys) {
                if (noiseValue >= TILE_TYPES[typeName].minHeight) {
                    currentTileType = TILE_TYPES[typeName];
                    material = materials[typeName];
                    elevation = currentTileType.baseElevation;
                    break; // Found the highest applicable type
                }
            }

            // Create tile mesh
            // *** IMPORTANT: Adjust elevation slightly based on noise for smoother terrain ***
            // Let's make the height transition smoother within a tile type range
            let heightVariation = 0;
            if (currentTileType !== TILE_TYPES.WATER) {
                 // Find the minHeight of the *next* lower tile type (or 0 if water)
                 let lowerBound = 0;
                 const currentTypeIndex = typeKeys.indexOf(Object.keys(materials).find(key => materials[key] === material));
                 if (currentTypeIndex < typeKeys.length - 1) {
                     lowerBound = TILE_TYPES[typeKeys[currentTypeIndex + 1]].minHeight;
                 }
                 // Normalize noiseValue within the current tile's range
                 const normalizedHeight = (noiseValue - currentTileType.minHeight) / (1 - currentTileType.minHeight); // Simple normalization
                 heightVariation = normalizedHeight * 0.3; // Adjust the multiplier for variation strength
            }

            const finalElevation = elevation + heightVariation;
            // *** Scale the tile height based on elevation difference ***
            let tileHeight = TILE_SIZE; // Default
            if (currentTileType !== TILE_TYPES.WATER) {
                // Make tiles taller for higher ground to fill gaps, relative to water level
                 tileHeight = TILE_SIZE + (finalElevation - TILE_TYPES.WATER.baseElevation) ;
            } else {
                 tileHeight = TILE_SIZE * 0.2; // Make water tiles thin
            }


            // Use a single BoxGeometry and scale it - more efficient
            const tileMesh = new THREE.Mesh(tileGeometry, material);
            tileMesh.scale.y = tileHeight / TILE_SIZE; // Scale Y based on calculated height
            tileMesh.position.set(worldX, finalElevation - (tileHeight/2 - TILE_SIZE/2), worldZ); // Adjust Y position so top is at finalElevation
            tileMesh.castShadow = true;
            tileMesh.receiveShadow = true;
            mapGroup.add(tileMesh);

            // Add tree if applicable
            if (currentTileType === TILE_TYPES.GRASS_TREE && Math.random() < treeProbability) {
                const trunkHeight = TILE_SIZE * 1.5;
                const leavesHeight = TILE_SIZE * 1.2;
                const trunkGeometry = new THREE.CylinderGeometry(TILE_SIZE * 0.1, TILE_SIZE * 0.15, trunkHeight, 6);
                const leavesGeometry = new THREE.ConeGeometry(TILE_SIZE * 0.5, leavesHeight, 8);

                const trunkMesh = new THREE.Mesh(trunkGeometry, trunkMaterial);
                const leavesMesh = new THREE.Mesh(leavesGeometry, leavesMaterial);

                 // Position tree relative to the top of the scaled tile
                const treeBaseY = finalElevation + TILE_SIZE/2; // Top surface of the base tile
                trunkMesh.position.set(worldX, treeBaseY + trunkHeight / 2, worldZ);
                leavesMesh.position.set(worldX, treeBaseY + trunkHeight + leavesHeight / 2, worldZ);


                trunkMesh.castShadow = true;
                leavesMesh.castShadow = true;
                // trunkMesh.receiveShadow = false; // Trunk less likely to receive shadows well
                // leavesMesh.receiveShadow = true;

                mapGroup.add(trunkMesh);
                mapGroup.add(leavesMesh);
            }
        }
         // Provide progress update for large maps
        if (x % (MAP_SIZE/10) === 0 && x > 0) { // Update more frequently
             console.log(`Generating map... ${Math.round((x/MAP_SIZE)*100)}%`);
        }
    }

    scene.add(mapGroup);
    console.log("Map generation complete.");
}


// --- Event Handling ---
function setupEventListeners() {
    const domElement = renderer.domElement;
    domElement.addEventListener('mousedown', onMouseDown, false);
    domElement.addEventListener('mousemove', onMouseMove, false);
    domElement.addEventListener('mouseup', onMouseUp, false);
    domElement.addEventListener('mouseleave', onMouseUp, false); // Treat leave as mouse up

    domElement.addEventListener('touchstart', onTouchStart, { passive: false }); // Add passive: false if preventing default scroll
    domElement.addEventListener('touchmove', onTouchMove, { passive: false }); // Add passive: false if preventing default scroll
    domElement.addEventListener('touchend', onTouchEnd, false);

    window.addEventListener('resize', onWindowResize, false);

    // Add Wheel listener for zooming
    domElement.addEventListener('wheel', onMouseWheel, { passive: false });
}

function onMouseDown(event) {
    isDragging = true;
    previousMousePosition.x = event.clientX;
    previousMousePosition.y = event.clientY;
}

function onMouseMove(event) {
    if (!isDragging) return;

    const deltaX = previousMousePosition.x - event.clientX;
    const deltaY = previousMousePosition.y - event.clientY;

    moveCamera(deltaX, deltaY);

    previousMousePosition.x = event.clientX;
    previousMousePosition.y = event.clientY;
}

function onMouseUp() {
    isDragging = false;
}

// --- Touch Events ---
function onTouchStart(event) {
    if (event.touches.length === 1) { // Handle single touch for panning
        // event.preventDefault(); // Prevent default scroll/zoom behavior
        isDragging = true;
        previousMousePosition.x = event.touches[0].clientX;
        previousMousePosition.y = event.touches[0].clientY;
    }
    // Basic Pinch-to-Zoom could be added here by tracking two touches
}

function onTouchMove(event) {
    if (!isDragging || event.touches.length !== 1) return;
    // event.preventDefault(); // Prevent default scroll/zoom behavior

    const deltaX = event.touches[0].clientX - previousMousePosition.x;
    const deltaY = event.touches[0].clientY - previousMousePosition.y;

    moveCamera(deltaX, deltaY);

    previousMousePosition.x = event.touches[0].clientX;
    previousMousePosition.y = event.touches[0].clientY;
}

function onTouchEnd(event) {
     // Check if the touch ending is the one we were tracking
    if (isDragging && event.touches.length < 1) { // Or check changedTouches
        isDragging = false;
    }
}

// --- Camera Movement & Zoom ---
function moveCamera(deltaX, deltaY) {
     // Calculate world units per pixel based on camera's current view height
    const worldUnitsPerPixelY = (camera.top - camera.bottom) / window.innerHeight;
    const worldUnitsPerPixelX = (camera.right - camera.left) / window.innerWidth;


    // Calculate movement vectors based on camera's orientation projected onto the ground plane (XZ)
    const forwardProj = new THREE.Vector3();
    camera.getWorldDirection(forwardProj);
    forwardProj.y = 0; // Project onto XZ plane
    forwardProj.normalize();

    const rightProj = new THREE.Vector3();
    // Create a camera 'right' vector projected onto the XZ plane
    rightProj.crossVectors(camera.up, forwardProj).normalize(); // This might point left depending on camera setup, reverse if needed
    // Note: camera.up is usually (0,1,0). If camera rolls, this needs adjustment.

    // Calculate the displacement vector
    // Moving mouse right (positive deltaX) should move view right -> camera position moves left relative to scene FORWARD
    // Moving mouse down (positive deltaY) should move view down -> camera position moves backward relative to scene FORWARD

    const moveVector = new THREE.Vector3();
    // Adjust the scaling factor if movement feels too fast/slow
    const moveSpeedFactor = 1.0;
    moveVector.addScaledVector(rightProj, -deltaX * worldUnitsPerPixelX * moveSpeedFactor); // Negative deltaX moves camera along positive rightProj
    moveVector.addScaledVector(forwardProj, -deltaY * worldUnitsPerPixelY * moveSpeedFactor); // Negative deltaY moves camera along positive forwardProj


    // Apply the movement to the camera's position AND the target it looks at
    camera.position.add(moveVector);

    // --- Boundary Clamping (Optional but recommended) ---
    // clampCameraPosition(); // Implement this if needed
}

function onMouseWheel(event) {
    event.preventDefault(); // Prevent page scroll

    const zoomFactor = 0.1; // How much to zoom per wheel tick
    const zoomAmount = event.deltaY < 0 ? (1 - zoomFactor) : (1 + zoomFactor); // Zoom in or out

    // Adjust camera frustum size
    camera.left *= zoomAmount;
    camera.right *= zoomFactor;
    camera.top *= zoomAmount;
    camera.bottom *= zoomAmount;

     // Clamp zoom levels
    const minZoomHeight = 10; // Minimum orthographic height
    const maxZoomHeight = MAP_SIZE * TILE_SIZE * 1.5; // Maximum orthographic height
    camera.top = Math.max(minZoomHeight / 2, Math.min(maxZoomHeight / 2, camera.top));
    camera.bottom = -camera.top;
    // Maintain aspect ratio after clamping top/bottom
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = camera.bottom * aspect;
    camera.right = camera.top * aspect;


    camera.updateProjectionMatrix(); // Crucial after changing frustum!

    // Optional: Adjust directional light shadow camera size based on zoom?
    // Can become complex. For now, leave it fixed.
}


function clampCameraPosition() {
    // Placeholder for boundary clamping logic if you want to prevent
    // the camera from moving too far away from the map center.
    // You'd calculate the visible map bounds based on the current zoom
    // and prevent camera.position from going beyond those limits.
}

// --- Window Resize ---
function onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;

    // Preserve the current zoom level (view height) while adjusting width
    const currentHeight = camera.top - camera.bottom;
    camera.top = currentHeight / 2;
    camera.bottom = -currentHeight / 2;
    camera.left = camera.bottom * aspect;
    camera.right = camera.top * aspect;

    camera.updateProjectionMatrix(); // Important after changing frustum!

    renderer.setSize(window.innerWidth, window.innerHeight);
    // clampCameraPosition(); // Re-clamp if implemented
}


// --- Animation Loop ---
function update() {
    requestAnimationFrame(update); // Request next frame

    // *** Calculate Delta Time and FPS ***
    const deltaTime = clock.getDelta(); // Time since last frame in seconds
    const fps = 1 / deltaTime;
    // Update the counter text, rounding FPS to an integer
    fpsCounterElement.textContent = `FPS: ${Math.round(fps)}`;


    // Day/Night Cycle: Rotate the directional light
    const time = Date.now() * DAY_NIGHT_SPEED;
    const lightDistance = MAP_SIZE * 0.7; // Keep light orbiting outside the core map area
    directionalLight.position.x = Math.sin(time) * lightDistance;
    // Make the light rise and set more realistically (higher at midday)
    directionalLight.position.y = Math.abs(Math.cos(time)) * lightDistance * 1.5; // Higher peak
    directionalLight.position.z = Math.cos(time) * lightDistance; // East-West movement


    // Keep light targetting the center (or adjust if camera moves significantly)
    // If camera pans a lot, you might want the light to target camera.lookAt point
     directionalLight.target.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(10)); // Target slightly ahead of camera
     directionalLight.target.y = 0; // Keep target on the ground plane


    // Render the scene
    renderer.render(scene, camera);
}

// Assuming THREE and SimplexNoise are available globally
start();