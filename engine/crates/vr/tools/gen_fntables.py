# Generates src/sys.rs, the Rust FFI for the OpenVR function tables, from openvr_capi.h, cross-checking
# method order and arity against the C++ classes in openvr.h. Headers are in the ValveSoftware/openvr
# release (headers/). Usage: python -I gen_fntables.py <openvr_capi.h> <openvr.h> <out.rs> <tag>
import re, sys

capi_path, hdr_path, out_path, tag = sys.argv[1:5]
capi = open(capi_path, encoding='utf-8').read()
hdr = open(hdr_path, encoding='utf-8').read()

IFACES = ['IVRSystem', 'IVRCompositor', 'IVROverlay', 'IVRChaperone', 'IVRInput']

# ---------- typedef / enum / struct tables from the C header ----------
PRIM = {
    'void': '()', 'bool': 'bool', 'char': 'c_char', 'int': 'i32', 'float': 'f32', 'double': 'f64',
    'uint8_t': 'u8', 'int8_t': 'i8', 'uint16_t': 'u16', 'int16_t': 'i16', 'unsigned short': 'u16',
    'uint32_t': 'u32', 'int32_t': 'i32', 'uint64_t': 'u64', 'int64_t': 'i64', 'intptr_t': 'isize',
    'unsigned int': 'u32', 'vrshared_uint64_t': 'u64', 'vrshared_double': 'f64',
}
SIZE = {'()': 0, 'bool': 1, 'c_char': 1, 'u8': 1, 'i8': 1, 'u16': 2, 'i16': 2, 'i32': 4, 'u32': 4,
        'f32': 4, 'u64': 8, 'i64': 8, 'f64': 8, 'isize': 8}

alias = {}
for m in re.finditer(r'^typedef\s+([A-Za-z_][\w ]*?)\s+(\w+);', capi, re.M):
    src, name = m.group(1).strip(), m.group(2)
    if name in ('bool',):
        continue
    alias.setdefault(name, src)
for m in re.finditer(r'^typedef\s+void\s*\*\s*(\w+);', capi, re.M):
    alias[m.group(1)] = 'void *'

enums = {}
for m in re.finditer(r'typedef enum (\w+)\s*\{(.*?)\}\s*\1;', capi, re.S):
    vals = []
    for line in m.group(2).splitlines():
        lm = re.match(r'\s*(\w+)\s*=\s*(-?\w+),', line)
        if lm:
            vals.append((lm.group(1), lm.group(2)))
    enums[m.group(1)] = vals

structs = {}
for m in re.finditer(r'typedef struct (\w+)\s*\{(.*?)\}\s*\1;', capi, re.S):
    structs[m.group(1)] = m.group(2)
for m in re.finditer(r'^struct (\w+)\s*\{(.*?)\};', capi, re.S | re.M):
    if not m.group(1).endswith('_FnTable'):
        structs.setdefault(m.group(1), m.group(2))
unions = {}
for m in re.finditer(r'typedef union\s*\{(.*?)\}\s*(\w+);', capi, re.S):
    unions[m.group(2)] = m.group(1)


def resolve(t):
    seen = 0
    while t in alias and seen < 10:
        t = alias[t]
        seen += 1
    return t


def parse_field(line):
    line = line.split('//')[0].strip().rstrip(';').strip()
    if not line:
        return None
    m = re.match(r'(.*?)(\w+)((?:\[\d+\])*)$', line)
    ty, name, arr = m.group(1).strip(), m.group(2), m.group(3)
    dims = [int(x) for x in re.findall(r'\[(\d+)\]', arr)]
    return ty, name, dims


def base_and_ptr(ty):
    ty = ty.replace('struct ', '').replace('enum ', '').replace('const ', '').strip()
    ptr = ty.count('*')
    base = ty.replace('*', '').strip()
    return base, ptr


# ---------- layout calculator (MSVC x64, default pack 8 = natural) ----------
def layout(name):
    """returns (size, align) of a C type name"""
    r = resolve(name)
    if r == 'void *':
        return 8, 8
    if r in PRIM:
        s = SIZE[PRIM[r]]
        return s, s
    if r in enums:
        return 4, 4
    if r in structs:
        off, al = 0, 1
        for line in structs[r].splitlines():
            f = parse_field(line)
            if not f:
                continue
            base, ptr = base_and_ptr(f[0])
            s, a = (8, 8) if ptr else layout(base)
            n = 1
            for d in f[2]:
                n *= d
            off = (off + a - 1) // a * a + s * n
            al = max(al, a)
        return (off + al - 1) // al * al, al
    if r in unions:
        sz, al = 0, 1
        for line in unions[r].splitlines():
            f = parse_field(line)
            if not f:
                continue
            base, ptr = base_and_ptr(f[0])
            s, a = (8, 8) if ptr else layout(base)
            sz, al = max(sz, s), max(al, a)
        return (sz + al - 1) // al * al, al
    raise KeyError(name)


# ---------- Rust type mapping ----------
DEFINED_STRUCTS = ['HmdMatrix34_t', 'HmdMatrix44_t', 'HmdVector3_t', 'HmdVector2_t', 'HmdColor_t',
                   'HmdRect2_t', 'HmdQuad_t', 'HiddenAreaMesh_t', 'TrackedDevicePose_t', 'Texture_t',
                   'VRTextureBounds_t', 'VREvent_Controller_t', 'VREvent_Mouse_t', 'VREvent_Scroll_t',
                   'VREvent_Overlay_t', 'VREvent_Process_t', 'VREvent_Status_t', 'VREvent_Keyboard_t',
                   'VREvent_SeatedZeroPoseReset_t', 'VREvent_Reserved_t', 'VREvent_t',
                   'VRActiveActionSet_t', 'InputDigitalActionData_t', 'InputAnalogActionData_t',
                   'InputPoseActionData_t', 'InputOriginInfo_t']
enum_refs = set()
opaque_refs = set()


def rust_base(base):
    if base in ('VROverlayHandle_t', 'TrackedDeviceIndex_t', 'TextureID_t', 'glUInt_t', 'PropertyTypeTag_t',
                'VRActionHandle_t', 'VRActionSetHandle_t', 'VRInputValueHandle_t'):
        return base
    r = resolve(base)
    if r == 'void *':
        return '*mut c_void'
    if r in PRIM:
        return PRIM[r]
    if r in enums or base in enums:
        enum_refs.add(r if r in enums else base)
        return r if r in enums else base
    if base in DEFINED_STRUCTS or r in DEFINED_STRUCTS:
        return r if r in DEFINED_STRUCTS else base
    if r == 'VREvent_Data_t':
        return 'VREvent_Data_t'
    return None  # opaque / unknown


def rust_type(cty, is_const=False):
    base, ptr = base_and_ptr(cty)
    rb = rust_base(base)
    if ptr == 0:
        if rb is None:
            raise SystemExit('by-value type without definition: ' + cty)
        return rb
    if rb is None or rb == '()':
        if rb is None:
            opaque_refs.add(base)
        rb = 'c_void'
    q = '*const ' if is_const else '*mut '
    return q * 1 + ('*mut ' * (ptr - 1)) + rb


# ---------- FnTables from capi ----------
def fntable(iface):
    m = re.search(r'struct VR_%s_FnTable\s*\{(.*?)\};' % iface, capi, re.S)
    out = []
    for line in m.group(1).strip().splitlines():
        lm = re.match(r'\s*(.+?)\s*\(OPENVR_FNTABLE_CALLTYPE \*(\w+)\)\((.*)\);\s*$', line)
        if not lm:
            raise SystemExit('unparsed: ' + line)
        ret, name, args = lm.groups()
        argl = []
        if args.strip():
            for a in args.split(','):
                a = a.strip()
                am = re.match(r'(.*?)(\w+)$', a)
                argl.append((am.group(1).strip(), am.group(2)))
        out.append((name, ret.strip(), argl))
    return out


# ---------- C++ classes from openvr.h (for cross-check + const-ness) ----------
def cpp_methods(iface):
    m = re.search(r'\bclass %s\s*\n\s*\{' % iface, hdr)
    i = m.end()
    depth = 1
    j = i
    while depth:
        c = hdr[j]
        depth += (c == '{') - (c == '}')
        j += 1
    body = hdr[i:j - 1]
    body = re.sub(r'/\*.*?\*/', ' ', body, flags=re.S)
    body = re.sub(r'//[^\n]*', ' ', body)
    body = re.sub(r'#[^\n]*', ' ', body)
    meths = []
    for mm in re.finditer(r'virtual\s+(.*?)\s*\b(\w+)\s*\((.*?)\)\s*(?:const\s*)?=\s*0\s*;', body, re.S):
        args = mm.group(3)
        args = re.sub(r'VR_\w+\s*\([^()]*\)', ' ', args)
        args = re.sub(r'=\s*[^,]+', '', args)
        argl = [a.strip() for a in args.split(',') if a.strip() and a.strip() != 'void']
        meths.append((mm.group(2), argl))
    return meths


def struct_rs(name):
    body = structs[name]
    lines = []
    for line in body.splitlines():
        f = parse_field(line)
        if not f:
            continue
        rt = rust_type(f[0])
        for d in reversed(f[2]):
            rt = '[%s; %d]' % (rt, d)
        lines.append('    pub %s: %s,' % (f[1], rt))
    return lines


report = []
o = []
w = o.append
w('// Generated by tools/gen_fntables.py from ValveSoftware/openvr %s' % tag)
w('// headers/openvr_capi.h (+ openvr.h cross-check). Windows x64 only: every vrtypes struct is')
w('// #pragma pack(8) on _WIN32 (natural alignment == #[repr(C)]); the pack(4) variants are Linux/macOS only.')
w('// FnTable callconv is OPENVR_FNTABLE_CALLTYPE = __stdcall on _WIN32, which is the x64 C ABI -> extern "system".')
w('// Exported VR_* entry points are VR_CALLTYPE = __cdecl -> extern "C".')
w('// Enums are #[repr(transparent)] i32 newtypes (MSVC enums are int); unknown values stay sound.')
w('// Pointer args to structs not defined here are *mut c_void (C type: see openvr_capi.h); we never call those.')
w('#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals, dead_code)]')
w('use std::ffi::{c_char, c_void};')
w('')
w('pub type TrackedDeviceIndex_t = u32;')
w('pub type VROverlayHandle_t = u64;')
w('pub type PropertyTypeTag_t = u32;')
w('pub type TextureID_t = i32;')
w('pub type glUInt_t = u32;')
w('pub type VRActionHandle_t = u64;')
w('pub type VRActionSetHandle_t = u64;')
w('pub type VRInputValueHandle_t = u64;')
w('')
for cname in ['k_unTrackedDeviceIndex_Hmd', 'k_unMaxTrackedDeviceCount', 'k_unTrackedDeviceIndexInvalid',
              'k_unVROverlayMaxKeyLength', 'k_unVROverlayMaxNameLength', 'k_unMaxOverlayCount']:
    mm = re.search(r'static const unsigned long %s = (\d+);' % cname, capi)
    w('pub const %s: u32 = %s;' % (cname, mm.group(1)))
w('pub const k_ulOverlayHandleInvalid: u64 = 0;')
w('pub const k_ulInvalidActionHandle: u64 = 0;')
w('pub const k_ulInvalidActionSetHandle: u64 = 0;')
w('pub const k_ulInvalidInputValueHandle: u64 = 0;')
for v in ['IVRSystem', 'IVRCompositor', 'IVROverlay', 'IVRChaperone', 'IVRInput']:
    mm = re.search(r'static const char \* %s_Version = "(\w+)";' % v, capi)
    w('pub const %s_Version: &str = "%s";' % (v, mm.group(1)))
    w('/// Pass to VR_GetGenericInterface to receive a *const VR_%s_FnTable (NUL-terminated).' % v)
    w('pub const %s_FnTable: &[u8] = b"FnTable:%s\\0";' % (v, mm.group(1)))
w('')

# structs
for s in ['HmdMatrix34_t', 'HmdMatrix44_t', 'HmdVector3_t', 'HmdVector2_t', 'HmdColor_t', 'HmdRect2_t',
          'HmdQuad_t', 'HiddenAreaMesh_t', 'TrackedDevicePose_t', 'Texture_t', 'VRTextureBounds_t',
          'VREvent_Reserved_t', 'VREvent_Controller_t', 'VREvent_Mouse_t', 'VREvent_Scroll_t',
          'VREvent_Overlay_t', 'VREvent_Process_t', 'VREvent_Status_t', 'VREvent_Keyboard_t',
          'VREvent_SeatedZeroPoseReset_t', 'VRActiveActionSet_t', 'InputDigitalActionData_t',
          'InputAnalogActionData_t', 'InputPoseActionData_t', 'InputOriginInfo_t']:
    sz, al = layout(s)
    w('/// C size %d, align %d (computed from openvr_capi.h)' % (sz, al))
    w('#[repr(C)]')
    w('#[derive(Copy, Clone, Debug, Default)]' if s not in ('HiddenAreaMesh_t', 'Texture_t', 'InputOriginInfo_t') else '#[derive(Copy, Clone, Debug)]')
    w('pub struct %s {' % s)
    o.extend(struct_rs(s))
    w('}')
    w('')

# VREvent_Data_t: subset union, size pinned by VREvent_Reserved_t (largest member).
members = []
for line in unions['VREvent_Data_t'].splitlines():
    f = parse_field(line)
    if f:
        members.append((f[0], f[1], layout(f[0].replace('struct ', ''))[0]))
usz, ual = layout('VREvent_Data_t')
evsz, eval_ = layout('VREvent_t')
largest = [m for m in members if m[2] == max(x[2] for x in members)]
report.append('VREvent_Data_t members=%d size=%d align=%d largest=%s' % (len(members), usz, ual, [(m[0], m[2]) for m in largest]))
report.append('VREvent_t size=%d align=%d' % (evsz, eval_))
w('/// Full C union has %d members; largest is %d bytes (%s). Subset kept here; `reserved` pins the size.'
  % (len(members), max(m[2] for m in members), ', '.join(m[0] for m in largest)))
w('#[repr(C)]')
w('#[derive(Copy, Clone)]')
w('pub union VREvent_Data_t {')
keep = ['reserved', 'controller', 'mouse', 'scroll', 'process', 'overlay', 'status', 'keyboard', 'seatedZeroPoseReset']
for ty, nm, sz in members:
    if nm in keep:
        w('    pub %s: %s,' % (nm, ty))
w('}')
w('')
w('/// C size %d, align %d on Win64 (pack 8). Pass size_of::<VREvent_t>() as uncbVREvent.' % (evsz, eval_))
w('#[repr(C)]')
w('#[derive(Copy, Clone)]')
w('pub struct VREvent_t {')
o.extend(struct_rs('VREvent_t'))
w('}')
w('')
w('const _: () = assert!(std::mem::size_of::<VREvent_Data_t>() == %d);' % usz)
w('const _: () = assert!(std::mem::size_of::<VREvent_t>() == %d);' % evsz)
w('const _: () = assert!(std::mem::offset_of!(VREvent_t, data) == 16);')
for s in ['HmdMatrix34_t', 'HmdMatrix44_t', 'TrackedDevicePose_t', 'Texture_t', 'VRTextureBounds_t',
          'VREvent_Mouse_t', 'VREvent_Scroll_t', 'HmdColor_t', 'HiddenAreaMesh_t', 'VRActiveActionSet_t',
          'InputDigitalActionData_t', 'InputAnalogActionData_t', 'InputPoseActionData_t', 'InputOriginInfo_t']:
    w('const _: () = assert!(std::mem::size_of::<%s>() == %d);' % (s, layout(s)[0]))
w('')

# FnTables
tables_rs = []
for iface in IFACES:
    ft = fntable(iface)
    cm = cpp_methods(iface)
    names_c = [x[0] for x in ft]
    names_h = [x[0] for x in cm]
    mismatch = [(i, a, b) for i, (a, b) in enumerate(zip(names_c, names_h)) if a != b]
    arity = [(x[0], len(x[2]), len(y[1])) for x, y in zip(ft, cm) if len(x[2]) != len(y[1])]
    report.append('%s: capi fields=%d, openvr.h virtuals=%d, name mismatches=%s, arity mismatches=%s'
                  % (iface, len(ft), len(cm), mismatch or 'none', arity or 'none'))
    tables_rs.append('/// %d fields; order verified against class %s in openvr.h.' % (len(ft), iface))
    tables_rs.append('#[repr(C)]')
    tables_rs.append('pub struct VR_%s_FnTable {' % iface)
    for (name, ret, args), (_, hargs) in zip(ft, cm):
        parts = []
        for k, (aty, anm) in enumerate(args):
            hconst = k < len(hargs) and re.match(r'\s*const\b', hargs[k]) is not None and '*' in aty
            rk = {'type', 'ref', 'self', 'match', 'move', 'fn', 'in', 'loop', 'mod', 'use'}
            parts.append('%s: %s' % ('r#' + anm if anm in rk else anm, rust_type(aty, hconst)))
        r = rust_type(ret)
        rs = '' if r == '()' else ' -> ' + r
        tables_rs.append('    pub %s: Option<unsafe extern "system" fn(%s)%s>,' % (name, ', '.join(parts), rs))
    tables_rs.append('}')
    tables_rs.append('const _: () = assert!(std::mem::size_of::<VR_%s_FnTable>() == %d * 8);' % (iface, len(ft)))
    tables_rs.append('')

# Enums (newtypes). Full variant lists except where filtered.
WANT_ALL = ['EVREye', 'ETextureType', 'EColorSpace', 'ETrackingUniverseOrigin', 'EVRCompositorError',
            'EVROverlayError', 'VROverlayInputMethod', 'VROverlayFlags', 'EVRButtonId', 'EVRApplicationType',
            'EVRSubmitFlags', 'ETrackingResult', 'ETrackedDeviceClass', 'ETrackedControllerRole',
            'EVRInitError', 'VROverlayTransformType', 'EDeviceActivityLevel', 'EVRState', 'EVRMouseButton',
            'EVRInputError']
WANT_SOME = {
    'EVREventType': ['VREvent_None', 'VREvent_TrackedDeviceActivated', 'VREvent_TrackedDeviceDeactivated',
                     'VREvent_TrackedDeviceUserInteractionStarted', 'VREvent_TrackedDeviceUserInteractionEnded',
                     'VREvent_ButtonPress', 'VREvent_ButtonUnpress', 'VREvent_ButtonTouch', 'VREvent_ButtonUntouch',
                     'VREvent_MouseMove', 'VREvent_MouseButtonDown', 'VREvent_MouseButtonUp',
                     'VREvent_FocusEnter', 'VREvent_FocusLeave', 'VREvent_ScrollDiscrete', 'VREvent_ScrollSmooth',
                     'VREvent_OverlayShown', 'VREvent_OverlayHidden', 'VREvent_DashboardActivated',
                     'VREvent_DashboardDeactivated', 'VREvent_SeatedZeroPoseReset',
                     'VREvent_StandingZeroPoseReset', 'VREvent_ChaperoneUniverseHasChanged', 'VREvent_Quit',
                     'VREvent_ProcessQuit', 'VREvent_DriverRequestedQuit', 'VREvent_SceneApplicationStateChanged',
                     'VREvent_InputFocusChanged', 'VREvent_IpdChanged', 'VREvent_EnterStandbyMode',
                     'VREvent_LeaveStandbyMode', 'VREvent_ActionBindingReloaded', 'VREvent_Input_BindingLoadFailed',
                     'VREvent_Input_ActionManifestLoadFailed', 'VREvent_Input_BindingsUpdated'],
    'ETrackedDeviceProperty': ['Prop_TrackingSystemName_String', 'Prop_ModelNumber_String',
                               'Prop_DisplayFrequency_Float', 'Prop_SecondsFromVsyncToPhotons_Float',
                               'Prop_UserIpdMeters_Float', 'Prop_ManufacturerName_String'],
}
enum_rs = []
for e in sorted(enum_refs | set(WANT_ALL) | set(WANT_SOME)):
    vals = enums.get(e)
    if vals is None:
        raise SystemExit('missing enum ' + e)
    enum_rs.append('#[repr(transparent)]')
    enum_rs.append('#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]')
    enum_rs.append('pub struct %s(pub i32);' % e)
    pick = vals if e in WANT_ALL else [v for v in vals if v[0][len(e) + 1:] in WANT_SOME.get(e, [])]
    if e in WANT_SOME:
        got = {v[0][len(e) + 1:] for v in pick}
        missing = set(WANT_SOME[e]) - got
        if missing:
            report.append('MISSING %s values: %s' % (e, sorted(missing)))
    if pick:
        enum_rs.append('impl %s {' % e)
        for cn, val in pick:
            short = cn[len(e) + 1:] if cn.startswith(e + '_') else cn
            enum_rs.append('    pub const %s: Self = Self(%s);' % (short, val))
        enum_rs.append('}')
    enum_rs.append('')

o.extend(enum_rs)
w('impl VREvent_t {')
w('    pub fn event_type(&self) -> EVREventType { EVREventType(self.eventType as i32) }')
w('}')
w('')
o.extend(tables_rs)

# Exported entry points (openvr.h VR_INTERFACE ... VR_CALLTYPE = __cdecl).
w('// Exported by openvr_api.dll. Load with libloading::Library::get::<T>(b"VR_InitInternal2\\0").')
w('pub type PFN_VR_InitInternal2 = unsafe extern "C" fn(peError: *mut EVRInitError, eApplicationType: EVRApplicationType, pStartupInfo: *const c_char) -> u32;')
w('pub type PFN_VR_ShutdownInternal = unsafe extern "C" fn();')
w('pub type PFN_VR_IsHmdPresent = unsafe extern "C" fn() -> bool;')
w('pub type PFN_VR_IsRuntimeInstalled = unsafe extern "C" fn() -> bool;')
w('pub type PFN_VR_GetRuntimePath = unsafe extern "C" fn(pchPathBuffer: *mut c_char, unBufferSize: u32, punRequiredBufferSize: *mut u32) -> bool;')
w('pub type PFN_VR_GetGenericInterface = unsafe extern "C" fn(pchInterfaceVersion: *const c_char, peError: *mut EVRInitError) -> *mut c_void;')
w('pub type PFN_VR_IsInterfaceVersionValid = unsafe extern "C" fn(pchInterfaceVersion: *const c_char) -> bool;')
w('pub type PFN_VR_GetInitToken = unsafe extern "C" fn() -> u32;')
w('pub type PFN_VR_GetVRInitErrorAsSymbol = unsafe extern "C" fn(error: EVRInitError) -> *const c_char;')
w('pub type PFN_VR_GetVRInitErrorAsEnglishDescription = unsafe extern "C" fn(error: EVRInitError) -> *const c_char;')
w('')
report.append('opaque pointer types (mapped to c_void): ' + ', '.join(sorted(opaque_refs)))
report.append('enums emitted: %d' % len(enum_rs and [l for l in enum_rs if l.startswith('pub struct')]))
open(out_path, 'w', encoding='utf-8', newline='\n').write('\n'.join(o) + '\n')
print('\n'.join(report))
