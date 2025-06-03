---
---
$(function() {
  // Use a local object to store each conf's moment‐deadline
  var deadlineByConf = {};

  {% for conf in site.data.conferences %}
  // {{ conf.name }} {{ conf.year }}
  {% if conf.deadline[0] == "TBA" %}
  {% assign conf_id = conf.name | append: conf.year | append: '-0' | slugify %}
  $('#{{ conf_id }} .timer').html("TBA");
  $('#{{ conf_id }} .deadline-time').html("TBA");
  // Assign a far‐future placeholder so that sorting treats it as “not yet”
  deadlineByConf["{{ conf_id }}"] = moment.tz("3000-01-01", "Etc/GMT+12");

  {% else %}
  // Read rawDeadlines (array or single value)
  var rawDeadlines = {{ conf.deadline | jsonify }} || [];
  if (rawDeadlines.constructor !== Array) {
    rawDeadlines = [rawDeadlines];
  }
  var parsedDeadlines = [];
  while (rawDeadlines.length > 0) {
    var rawDeadline = rawDeadlines.pop();
    // Replace year placeholders
    var year = {{ conf.year }};
    rawDeadline = rawDeadline.replace('%y', year).replace('%Y', year - 1);

    // Parse with the specified timezone (or “Anywhere on Earth” if none)
    {% if conf.timezone %}
    var deadline = moment.tz(rawDeadline, "{{ conf.timezone }}");
    {% else %}
    var deadline = moment.tz(rawDeadline, "Etc/GMT+12");
    {% endif %}

    if (deadline.isValid()) {
      // If minutes = 0, bump back 1 second (so it shows “23:59:59” of the previous hour)
      if (deadline.minutes() === 0) {
        deadline.subtract(1, 'seconds');
      }
      // If minutes = 59, set seconds to 59 (to show end of the minute)
      if (deadline.minutes() === 59) {
        deadline.seconds(59);
      }
    }
    parsedDeadlines.push(deadline);
  }
  // Reverse so that index “i” corresponds to the correct position
  parsedDeadlines.reverse();

  {% assign range_end = conf.deadline.size | minus: 1 %}
  {% for i in (0..range_end) %}
  {% assign conf_id = conf.name | append: conf.year | append: '-' | append: i | slugify %}
  var deadlineIndex = {{ i }};
  if (deadlineIndex < parsedDeadlines.length) {
    var confDeadline = parsedDeadlines[deadlineIndex];

    if (confDeadline && confDeadline.isValid()) {
      // Countdown‐update function
      function make_update_countdown_fn(confDeadline) {
        return function(event) {
          var diff = moment().valueOf() - confDeadline.valueOf();
          if (diff <= 0) {
            // Still upcoming: show “DD days HHh MMm SSs”
            $(this).html(event.strftime('%D days %Hh %Mm %Ss'));
          } else {
            // Passed: show “2 days ago” / “in X”
            $(this).html(confDeadline.fromNow());
          }
        };
      }

      // Initialize the countdown plugin
      $('#{{ conf_id }} .timer').countdown(
        confDeadline.toDate(),
        make_update_countdown_fn(confDeadline)
      );

      // If it’s already passed, add a “past” class
      if (moment().valueOf() - confDeadline.valueOf() > 0) {
        $('#{{ conf_id }}').addClass('past');
      }

      // Render the visible “deadline-time” text (local timezone)
      $('#{{ conf_id }} .deadline-time')
        .html(confDeadline.local().format('D MMM YYYY, h:mm:ss a'));

      // Store for sorting later
      deadlineByConf["{{ conf_id }}"] = confDeadline;
    }
  } else {
    // (Optional) If there is no corresponding parsedDeadlines[i], you could hide this item:
    // $('#{{ conf_id }}').hide();
  }
  {% endfor %}
  {% endif %}
  {% endfor %}

  // ----- Reorder the list based on deadlineByConf -----
  var today = moment();
  var confs = $('.conf').detach();
  confs.sort(function(a, b) {
    var aDeadline = deadlineByConf[a.id];
    var bDeadline = deadlineByConf[b.id];

    // If aDeadline is missing or invalid, push it to the bottom
    if (!aDeadline || !aDeadline.isValid()) {
      return 1;
    }
    // If bDeadline is missing or invalid, push b to the bottom (so a comes first)
    if (!bDeadline || !bDeadline.isValid()) {
      return -1;
    }

    var aDiff = today.diff(aDeadline); // negative if future, positive if past
    var bDiff = today.diff(bDeadline);

    // If a is upcoming (aDiff<0) and b is past (bDiff>0), a < b
    if (aDiff < 0 && bDiff > 0) {
      return -1;
    }
    // If a is past and b is upcoming, a > b
    if (aDiff > 0 && bDiff < 0) {
      return 1;
    }
    // Otherwise both are in the same “side” (both future or both past)—sort by how recently they occur:
    //   For two future deadlines, the one with a smaller (more negative) diff is sooner → show first
    //   For two past deadlines, the one with a larger (more positive) diff is more recently past → show first
    return bDiff - aDiff;
  });
  $('.conf-container').append(confs);

  // ----- Set up tag‐based filtering -----
  var conf_type_data = {{ site.data.types | jsonify }};
  var all_tags = [];
  var toggle_status = {};

  for (var i = 0; i < conf_type_data.length; i++) {
    all_tags.push(conf_type_data[i].tag);
    toggle_status[conf_type_data[i].tag] = false;
  }

  // Load saved tags from localStorage (via store.js)
  var savedTags = store.get('{{ site.domain }}');
  if (savedTags === undefined) {
    savedTags = all_tags.slice(); // default: all tags
    store.set('{{ site.domain }}', savedTags);
  }

  // Initialize checkboxes (set to false by default)
  for (var j = 0; j < all_tags.length; j++) {
    var tag = all_tags[j];
    $('#' + tag + '-checkbox').prop('checked', false);
    toggle_status[tag] = false;
  }
  store.set('{{ site.domain }}', savedTags);

  function update_conf_list() {
    confs.each(function(_, confElem) {
      var $conf = $(confElem);
      var shouldShow = true;
      var selectedTags = [];

      // Collect which tags are currently “on”
      for (var k = 0; k < all_tags.length; k++) {
        var t = all_tags[k];
        if (toggle_status[t]) {
          selectedTags.push($conf.hasClass(t));
        }
      }

      // If no tag is selected (selectedTags.length === 0), show everything.
      // Otherwise, only show when every selected tag is present on this `<div class="conf …">`.
      if (selectedTags.length > 0) {
        shouldShow = selectedTags.every(Boolean);
      }

      if (shouldShow) {
        $conf.show();
      } else {
        $conf.hide();
      }
    });
  }
  update_conf_list();

  // When a checkbox changes state, update toggle_status and re‐filter
  $('form :checkbox').change(function() {
    var isChecked = $(this).is(':checked');
    var tagName = $(this).prop('id').slice(0, -9); // strip “-checkbox”
    toggle_status[tagName] = isChecked;

    if (isChecked) {
      if (savedTags.indexOf(tagName) < 0) {
        savedTags.push(tagName);
      }
    } else {
      var idx = savedTags.indexOf(tagName);
      if (idx >= 0) {
        savedTags.splice(idx, 1);
      }
    }
    store.set('{{ site.domain }}', savedTags);
    update_conf_list();
  });
});
